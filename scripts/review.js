const fs = require('fs');
const https = require('https');
const path = require('path');

// Configuration from environment variables
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AI_MODEL = process.env.AI_MODEL || 'anthropic/claude-3.5-sonnet';
const PR_TITLE = process.env.PR_TITLE || '';
const PR_BODY = process.env.PR_BODY || '';
const PR_NUMBER = process.env.PR_NUMBER || '';
const REPO_NAME = process.env.REPO_NAME || '';
const COMMIT_SHA = process.env.COMMIT_SHA || '';
const MAX_DIFF_SIZE = parseInt(process.env.MAX_DIFF_SIZE, 10) || 100000;
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.3;
const CUSTOM_PROMPT = process.env.CUSTOM_PROMPT || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';
const REVIEW_FOCUS = process.env.REVIEW_FOCUS || '';
const ACTION_PATH = process.env.ACTION_PATH || process.cwd();
const INLINE_COMMENTS = process.env.INLINE_COMMENTS !== 'false'; // Default to true

// OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Parse a git diff into individual file entries
 */
function parseDiffIntoFiles(diffContent) {
  const files = [];
  // Split by diff headers (diff --git a/... b/...)
  const diffPattern = /^diff --git a\/.+ b\/.+$/gm;
  const matches = [...diffContent.matchAll(diffPattern)];

  for (let i = 0; i < matches.length; i++) {
    const startIndex = matches[i].index;
    const endIndex = i + 1 < matches.length ? matches[i + 1].index : diffContent.length;
    const fileContent = diffContent.substring(startIndex, endIndex);

    // Extract file path from the diff header
    const headerMatch = fileContent.match(/^diff --git a\/(.+) b\/(.+)$/m);
    const oldPath = headerMatch ? headerMatch[1] : '';
    const newPath = headerMatch ? headerMatch[2] : '';

    // Determine the file status
    let status = 'modified';
    let isRename = false;
    let isBinary = false;

    if (fileContent.includes('deleted file mode')) {
      status = 'deleted';
    } else if (fileContent.includes('new file mode')) {
      status = 'added';
    } else if (fileContent.includes('rename from') || fileContent.includes('similarity index')) {
      status = 'renamed';
      isRename = true;
    }

    if (fileContent.includes('Binary files')) {
      isBinary = true;
    }

    files.push({
      oldPath,
      newPath,
      status,
      isRename,
      isBinary,
      content: fileContent
    });
  }

  return files;
}

/**
 * Optimize diff by summarizing deleted/renamed files to save tokens
 */
function optimizeDiff(diffContent) {
  const files = parseDiffIntoFiles(diffContent);
  const optimizedParts = [];
  const stats = {
    deleted: 0,
    renamed: 0,
    modified: 0,
    added: 0,
    binary: 0,
    tokensSaved: 0
  };

  for (const file of files) {
    if (file.status === 'deleted') {
      // For deleted files, just include a summary header
      stats.deleted++;
      stats.tokensSaved += file.content.length;
      optimizedParts.push(`diff --git a/${file.oldPath} b/${file.newPath}
deleted file mode 100644
[FILE DELETED - Content omitted to save tokens]
`);
    } else if (file.isRename && !hasSignificantChanges(file.content)) {
      // For renamed files with no significant changes, just show rename info
      stats.renamed++;
      const originalLength = file.content.length;
      const renameInfo = extractRenameInfo(file.content);
      stats.tokensSaved += originalLength - renameInfo.length;
      optimizedParts.push(renameInfo);
    } else if (file.isBinary) {
      // Binary files - just include header
      stats.binary++;
      stats.tokensSaved += file.content.length;
      optimizedParts.push(`diff --git a/${file.oldPath} b/${file.newPath}
[BINARY FILE - Content omitted]
`);
    } else {
      // Keep full content for modified and added files
      if (file.status === 'added') stats.added++;
      else if (file.status === 'renamed') stats.renamed++;
      else stats.modified++;
      optimizedParts.push(file.content);
    }
  }

  // Log optimization stats
  console.log('Diff optimization stats:');
  console.log(`  - Added files: ${stats.added}`);
  console.log(`  - Modified files: ${stats.modified}`);
  console.log(`  - Renamed files: ${stats.renamed}`);
  console.log(`  - Deleted files: ${stats.deleted}`);
  console.log(`  - Binary files: ${stats.binary}`);
  console.log(`  - Estimated tokens saved: ~${Math.round(stats.tokensSaved / 4)} tokens`);

  return optimizedParts.join('\n');
}

/**
 * Check if a renamed file has significant code changes beyond just the rename
 */
function hasSignificantChanges(fileContent) {
  // Count actual code change lines (+ or - at start, excluding +++ and ---)
  const lines = fileContent.split('\n');
  let changeCount = 0;

  for (const line of lines) {
    // Skip diff headers
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('diff --git')) continue;
    if (line.startsWith('index ')) continue;
    if (line.startsWith('similarity index')) continue;
    if (line.startsWith('rename from') || line.startsWith('rename to')) continue;
    if (line.startsWith('@@')) continue;

    // Count actual changes
    if (line.startsWith('+') || line.startsWith('-')) {
      changeCount++;
    }
  }

  // If there are more than a few lines of actual changes, consider it significant
  return changeCount > 5;
}

/**
 * Extract just the rename information from a renamed file diff
 */
function extractRenameInfo(fileContent) {
  const lines = fileContent.split('\n');
  const infoLines = [];

  for (const line of lines) {
    // Include header and rename-related lines
    if (line.startsWith('diff --git') ||
        line.startsWith('similarity index') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to') ||
        line.startsWith('index ')) {
      infoLines.push(line);
    }
  }

  infoLines.push('[FILE RENAMED - No significant code changes]');
  infoLines.push('');

  return infoLines.join('\n');
}

/**
 * Parse diff to extract file and line information for inline comments
 * Returns a map of filename -> { hunks: [...], lines: [...] }
 *
 * IMPORTANT: GitHub's position is 1-indexed and relative to the file's diff,
 * starting from the first line after the file header (the @@ line counts as position 1)
 */
function parseDiffForLineMapping(diffContent) {
  const fileMap = {};
  const files = parseDiffIntoFiles(diffContent);

  for (const file of files) {
    if (file.status === 'deleted' || file.isBinary) continue;

    const lines = file.content.split('\n');
    const hunks = [];
    let currentHunk = null;
    let diffPosition = 0; // Position relative to this file's diff (1-indexed, starts after file header)
    let inHunk = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip diff header lines (diff --git, index, ---, +++)
      if (line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('new file mode') ||
          line.startsWith('old file mode') ||
          line.startsWith('similarity index') ||
          line.startsWith('rename from') ||
          line.startsWith('rename to')) {
        continue;
      }

      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunkMatch) {
        diffPosition++; // The @@ line itself is position 1 (or continues from previous hunk)
        currentHunk = {
          oldStart: parseInt(hunkMatch[1], 10),
          newStart: parseInt(hunkMatch[3], 10),
          lines: []
        };
        hunks.push(currentHunk);
        inHunk = true;
        continue;
      }

      // Only count lines that are part of a hunk
      if (inHunk && currentHunk) {
        diffPosition++;

        if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line === '') {
          const lineType = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'delete' : 'context';

          // Calculate the actual line number in the new file
          let newLineNumber = null;
          if (lineType !== 'delete') {
            newLineNumber = currentHunk.newStart + currentHunk.lines.filter(l => l.type !== 'delete').length;
          }

          currentHunk.lines.push({
            type: lineType,
            content: line,
            diffPosition: diffPosition,
            newLineNumber
          });
        }
      }
    }

    fileMap[file.newPath] = { hunks, status: file.status };
  }

  return fileMap;
}

/**
 * Find the diff position for a given file and line number
 */
function findDiffPosition(fileMap, filename, lineNumber) {
  const fileInfo = fileMap[filename];
  if (!fileInfo) return null;

  for (const hunk of fileInfo.hunks) {
    for (const line of hunk.lines) {
      if (line.newLineNumber === lineNumber && line.type !== 'delete') {
        return line.diffPosition;
      }
    }
  }

  // If exact line not found, find the closest line in the diff
  for (const hunk of fileInfo.hunks) {
    const linesInHunk = hunk.lines.filter(l => l.newLineNumber !== null);
    if (linesInHunk.length > 0) {
      const firstLine = linesInHunk[0].newLineNumber;
      const lastLine = linesInHunk[linesInHunk.length - 1].newLineNumber;

      if (lineNumber >= firstLine && lineNumber <= lastLine) {
        // Return the closest line's diff position
        let closest = linesInHunk[0];
        for (const l of linesInHunk) {
          if (Math.abs(l.newLineNumber - lineNumber) < Math.abs(closest.newLineNumber - lineNumber)) {
            closest = l;
          }
        }
        return closest.diffPosition;
      }
    }
  }

  return null;
}

/**
 * Read the PR diff from file
 */
function readDiff() {
  const diffPath = path.join(ACTION_PATH, 'pr_diff.txt');
  try {
    let diff = fs.readFileSync(diffPath, 'utf8');
    const originalSize = diff.length;

    // Optimize the diff to save tokens
    diff = optimizeDiff(diff);

    console.log(`Original diff size: ${originalSize} characters`);
    console.log(`Optimized diff size: ${diff.length} characters`);
    console.log(`Size reduction: ${Math.round((1 - diff.length / originalSize) * 100)}%`);

    if (diff.length > MAX_DIFF_SIZE) {
      console.log(`Diff is still too large (${diff.length} chars), truncating to ${MAX_DIFF_SIZE} chars`);
      diff = diff.substring(0, MAX_DIFF_SIZE) + '\n\n... [diff truncated due to size]';
    }

    return diff;
  } catch (error) {
    console.error('Error reading diff file:', error.message);
    return '';
  }
}

/**
 * Read the raw (non-optimized) diff for line mapping
 */
function readRawDiff() {
  const diffPath = path.join(ACTION_PATH, 'pr_diff.txt');
  try {
    return fs.readFileSync(diffPath, 'utf8');
  } catch (error) {
    console.error('Error reading diff file:', error.message);
    return '';
  }
}

/**
 * Get the default review focus areas
 */
function getDefaultFocusAreas() {
  return [
    { name: 'Code Quality', description: 'Identify any code smells, anti-patterns, or areas that could be improved' },
    { name: 'Potential Bugs', description: 'Look for logic errors, edge cases, or potential runtime issues' },
    { name: 'Security', description: 'Flag any security concerns or vulnerabilities' },
    { name: 'Performance', description: 'Note any performance implications' },
    { name: 'Best Practices', description: 'Suggest improvements based on industry best practices' },
    { name: 'Readability', description: 'Comment on code clarity and maintainability' }
  ];
}

/**
 * Parse custom review focus areas
 */
function parseFocusAreas(focusString) {
  if (!focusString) return null;

  const focusMap = {
    'security': { name: 'Security', description: 'Flag any security concerns, vulnerabilities, or unsafe practices' },
    'performance': { name: 'Performance', description: 'Identify performance bottlenecks, inefficient algorithms, or resource issues' },
    'bugs': { name: 'Potential Bugs', description: 'Look for logic errors, edge cases, null checks, or runtime issues' },
    'quality': { name: 'Code Quality', description: 'Identify code smells, anti-patterns, or areas needing improvement' },
    'readability': { name: 'Readability', description: 'Comment on code clarity, naming, and maintainability' },
    'testing': { name: 'Testing', description: 'Evaluate test coverage, test quality, and suggest additional tests' },
    'documentation': { name: 'Documentation', description: 'Check for missing or outdated documentation and comments' },
    'architecture': { name: 'Architecture', description: 'Review design patterns, separation of concerns, and modularity' },
    'accessibility': { name: 'Accessibility', description: 'Check for accessibility issues in UI code' },
    'error-handling': { name: 'Error Handling', description: 'Review error handling, logging, and recovery mechanisms' }
  };

  const areas = focusString.split(',').map(s => s.trim().toLowerCase());
  const result = [];

  for (const area of areas) {
    if (focusMap[area]) {
      result.push(focusMap[area]);
    }
  }

  return result.length > 0 ? result : null;
}

/**
 * Build the prompt for code review (returns structured JSON when inline comments enabled)
 */
function buildPrompt(diff, useStructuredOutput = false) {
  // Use custom focus areas if provided, otherwise use defaults
  const focusAreas = parseFocusAreas(REVIEW_FOCUS) || getDefaultFocusAreas();
  const focusListText = focusAreas
    .map((area, i) => `${i + 1}. **${area.name}**: ${area.description}`)
    .join('\n');

  let prompt = `You are an experienced software engineer performing a code review on a Pull Request.

## Pull Request Information
- **Repository**: ${REPO_NAME}
- **PR Number**: #${PR_NUMBER}
- **Title**: ${PR_TITLE}
- **Description**: ${PR_BODY || 'No description provided'}

## Code Changes (Diff)
**Note**: Deleted files and pure renames (with no code changes) are summarized to save tokens. Binary files are also omitted. The full context of actual code changes is preserved.

\`\`\`diff
${diff}
\`\`\`

## Your Task
Please review the code changes and provide constructive feedback. Focus on:

${focusListText}
`;

  if (useStructuredOutput) {
    prompt += `
## Response Format
You MUST respond with a valid JSON object (no markdown code blocks, just raw JSON). Use this exact structure:

{
  "summary": "A brief overview of the changes and your overall assessment.",
  "highlights": ["List of things done well in this PR"],
  "recommendation": "APPROVE" | "APPROVE_WITH_SUGGESTIONS" | "REQUEST_CHANGES",
  "inline_comments": [
    {
      "path": "exact/file/path.js",
      "line": 42,
      "severity": "critical" | "major" | "minor" | "suggestion",
      "message": "Description of the issue and suggested fix. Be specific and constructive."
    }
  ],
  "general_comments": [
    {
      "severity": "critical" | "major" | "minor" | "suggestion",
      "message": "General feedback that doesn't apply to a specific line"
    }
  ]
}

IMPORTANT:
- The "path" must exactly match the file path shown in the diff (e.g., "src/utils/helper.js")
- The "line" must be a line number from the NEW version of the file (lines with + prefix or unchanged lines)
- Only comment on lines that are actually in the diff (changed or context lines)
- Be constructive and helpful in your messages
- Include code suggestions when applicable`;
  } else {
    prompt += `
## Response Format
Structure your review as follows:

### Summary
A brief overview of the changes and your overall assessment.

### Highlights
What's done well in this PR.

### Issues & Suggestions
List specific issues or suggestions, referencing file names and line numbers where applicable. Use the following format for each item:
- **[Severity]** \`filename:line\` - Description of the issue and suggested fix

Severity levels: 🔴 Critical | 🟠 Major | 🟡 Minor | 💡 Suggestion

### Overall Recommendation
Your recommendation: ✅ Approve | ⚠️ Approve with suggestions | 🔄 Request changes

---
Keep the review concise but thorough. Be constructive and helpful.`;
  }

  // Append custom prompt if provided
  if (CUSTOM_PROMPT) {
    prompt += `\n\n## Additional Instructions\n${CUSTOM_PROMPT}`;
  }

  return prompt;
}

/**
 * Build the system prompt
 */
function buildSystemPrompt() {
  if (SYSTEM_PROMPT) {
    return SYSTEM_PROMPT;
  }
  return 'You are an expert code reviewer. Provide thorough, constructive feedback that helps developers improve their code. Be specific, cite line numbers, and explain the reasoning behind your suggestions.';
}

/**
 * Make API request to OpenRouter
 */
function callOpenRouter(prompt) {
  return new Promise((resolve, reject) => {
    const systemPrompt = buildSystemPrompt();
    const messages = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: prompt
      }
    ];

    const requestBody = JSON.stringify({
      model: AI_MODEL,
      messages: messages,
      max_tokens: 4000,
      temperature: TEMPERATURE
    });

    const url = new URL(OPENROUTER_API_URL);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': `https://github.com/${REPO_NAME}`,
        'X-Title': 'AI Code Reviewer'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API request failed with status ${res.statusCode}: ${data}`));
          return;
        }

        try {
          const response = JSON.parse(data);
          if (response.choices && response.choices[0] && response.choices[0].message) {
            resolve(response.choices[0].message.content);
          } else {
            reject(new Error('Unexpected API response format'));
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response: ${e.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(requestBody);
    req.end();
  });
}

/**
 * Format the review output (markdown format)
 */
function formatOutput(review) {
  return `## 🤖 AI Code Review

> **Model**: \`${AI_MODEL}\`
> **PR**: #${PR_NUMBER}

---

${review}

---
<sub>🔄 This review was automatically generated using [AI Code Reviewer](https://github.com/marketplace/actions/ai-code-reviewer) via OpenRouter API.</sub>
`;
}

/**
 * Format structured review to markdown
 */
function formatStructuredReviewToMarkdown(reviewData) {
  const severityEmoji = {
    critical: '🔴',
    major: '🟠',
    minor: '🟡',
    suggestion: '💡'
  };

  const recommendationEmoji = {
    APPROVE: '✅ Approve',
    APPROVE_WITH_SUGGESTIONS: '⚠️ Approve with suggestions',
    REQUEST_CHANGES: '🔄 Request changes'
  };

  let markdown = `## 🤖 AI Code Review

> **Model**: \`${AI_MODEL}\`
> **PR**: #${PR_NUMBER}

---

### Summary
${reviewData.summary}

### Highlights
${reviewData.highlights.map(h => `- ${h}`).join('\n')}

### Issues & Suggestions
`;

  // Add inline comments to markdown
  if (reviewData.inline_comments && reviewData.inline_comments.length > 0) {
    for (const comment of reviewData.inline_comments) {
      const emoji = severityEmoji[comment.severity] || '💡';
      markdown += `- ${emoji} **[${comment.severity.toUpperCase()}]** \`${comment.path}:${comment.line}\` - ${comment.message}\n`;
    }
  }

  // Add general comments
  if (reviewData.general_comments && reviewData.general_comments.length > 0) {
    markdown += '\n**General:**\n';
    for (const comment of reviewData.general_comments) {
      const emoji = severityEmoji[comment.severity] || '💡';
      markdown += `- ${emoji} ${comment.message}\n`;
    }
  }

  if ((!reviewData.inline_comments || reviewData.inline_comments.length === 0) &&
      (!reviewData.general_comments || reviewData.general_comments.length === 0)) {
    markdown += '_No issues found._\n';
  }

  markdown += `
### Overall Recommendation
${recommendationEmoji[reviewData.recommendation] || reviewData.recommendation}

---
<sub>🔄 This review was automatically generated using [AI Code Reviewer](https://github.com/marketplace/actions/ai-code-reviewer) via OpenRouter API.</sub>
`;

  return markdown;
}

/**
 * Make a GitHub API request
 */
function callGitHubAPI(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: endpoint,
      method: method,
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'AI-Code-Reviewer',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`GitHub API request failed with status ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Submit a PR review with inline comments via GitHub API
 */
async function submitPRReview(reviewData, fileMap) {
  const [owner, repo] = REPO_NAME.split('/');
  const prNumber = parseInt(PR_NUMBER, 10);

  // Build the review comments array
  const comments = [];

  if (reviewData.inline_comments) {
    for (const comment of reviewData.inline_comments) {
      // Find the position in the diff for this comment
      const position = findDiffPosition(fileMap, comment.path, comment.line);

      if (position) {
        const severityEmoji = {
          critical: '🔴 **CRITICAL**',
          major: '🟠 **MAJOR**',
          minor: '🟡 **MINOR**',
          suggestion: '💡 **SUGGESTION**'
        };

        console.log(`Adding inline comment: ${comment.path}:${comment.line} -> position ${position}`);
        comments.push({
          path: comment.path,
          position: position,
          body: `${severityEmoji[comment.severity] || ''}\n\n${comment.message}`
        });
      } else {
        console.log(`Warning: Could not find diff position for ${comment.path}:${comment.line}, will include in summary`);
      }
    }
  }

  // Map recommendation to GitHub event
  const eventMap = {
    APPROVE: 'APPROVE',
    APPROVE_WITH_SUGGESTIONS: 'COMMENT',
    REQUEST_CHANGES: 'REQUEST_CHANGES'
  };
  const event = eventMap[reviewData.recommendation] || 'COMMENT';

  // Build review body with summary and any comments that couldn't be placed inline
  let body = `## 🤖 AI Code Review Summary\n\n${reviewData.summary}\n\n`;

  if (reviewData.highlights && reviewData.highlights.length > 0) {
    body += `### ✨ Highlights\n${reviewData.highlights.map(h => `- ${h}`).join('\n')}\n\n`;
  }

  // Add general comments to body
  if (reviewData.general_comments && reviewData.general_comments.length > 0) {
    body += '### 📝 General Comments\n';
    const severityEmoji = { critical: '🔴', major: '🟠', minor: '🟡', suggestion: '💡' };
    for (const comment of reviewData.general_comments) {
      body += `- ${severityEmoji[comment.severity] || '💡'} ${comment.message}\n`;
    }
    body += '\n';
  }

  // Add any inline comments that couldn't be placed
  const unplacedComments = reviewData.inline_comments?.filter(c => !findDiffPosition(fileMap, c.path, c.line)) || [];
  if (unplacedComments.length > 0) {
    body += '### 📍 Additional Comments\n';
    const severityEmoji = { critical: '🔴', major: '🟠', minor: '🟡', suggestion: '💡' };
    for (const comment of unplacedComments) {
      body += `- ${severityEmoji[comment.severity] || '💡'} \`${comment.path}:${comment.line}\` - ${comment.message}\n`;
    }
    body += '\n';
  }

  body += `---\n<sub>🔄 Generated by [AI Code Reviewer](https://github.com/marketplace/actions/ai-code-reviewer) using \`${AI_MODEL}\`</sub>`;

  // Submit the review
  const reviewPayload = {
    body: body,
    event: event,
    comments: comments
  };

  console.log(`Submitting PR review with ${comments.length} inline comments...`);
  console.log(`Review event: ${event}`);

  try {
    const result = await callGitHubAPI(
      'POST',
      `/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      reviewPayload
    );
    console.log(`PR review submitted successfully! Review ID: ${result.id}`);
    return result;
  } catch (error) {
    console.error('Failed to submit PR review:', error.message);
    throw error;
  }
}

/**
 * Parse the AI response to extract JSON
 */
function parseStructuredResponse(response) {
  // Try to parse directly first
  try {
    return JSON.parse(response);
  } catch {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {
        // Continue to next attempt
      }
    }

    // Try to find JSON object in the response
    const objectMatch = response.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // Failed to parse
      }
    }

    throw new Error('Failed to parse structured response from AI');
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Starting AI Code Review...');
  console.log(`Model: ${AI_MODEL}`);
  console.log(`PR: ${REPO_NAME}#${PR_NUMBER}`);
  console.log(`Temperature: ${TEMPERATURE}`);
  console.log(`Max diff size: ${MAX_DIFF_SIZE}`);
  console.log(`Inline comments: ${INLINE_COMMENTS}`);

  // Validate API key
  if (!OPENROUTER_API_KEY) {
    console.error('Error: OPENROUTER_API_KEY is not set');
    process.exit(1);
  }

  // Check if we can use inline comments
  const useInlineComments = INLINE_COMMENTS && GITHUB_TOKEN && COMMIT_SHA;
  if (INLINE_COMMENTS && !GITHUB_TOKEN) {
    console.log('Warning: GITHUB_TOKEN not set, falling back to summary-only mode');
  }
  if (INLINE_COMMENTS && !COMMIT_SHA) {
    console.log('Warning: COMMIT_SHA not set, falling back to summary-only mode');
  }

  // Read the diff
  const diff = readDiff();
  if (!diff) {
    console.error('Error: No diff content found');
    process.exit(1);
  }

  console.log(`Diff size: ${diff.length} characters`);

  // Build prompt (use structured output for inline comments)
  const prompt = buildPrompt(diff, useInlineComments);

  // Call OpenRouter API
  console.log('Calling OpenRouter API...');
  try {
    const rawReview = await callOpenRouter(prompt);

    if (useInlineComments) {
      // Parse structured response
      console.log('Parsing structured review response...');
      let reviewData;
      try {
        reviewData = parseStructuredResponse(rawReview);
      } catch (parseError) {
        console.error('Failed to parse structured response, falling back to summary mode:', parseError.message);
        // Fall back to simple output
        const output = formatOutput(rawReview);
        const outputPath = path.join(ACTION_PATH, 'review_output.md');
        fs.writeFileSync(outputPath, output);
        console.log('Review completed (summary mode due to parse error)!');
        return;
      }

      // Parse the raw diff to get line mappings
      const rawDiff = readRawDiff();
      const fileMap = parseDiffForLineMapping(rawDiff);

      // Submit PR review with inline comments
      try {
        await submitPRReview(reviewData, fileMap);
        console.log('PR review with inline comments submitted successfully!');
      } catch (submitError) {
        console.error('Failed to submit PR review:', submitError.message);
        // Fall back to saving markdown output
        const output = formatStructuredReviewToMarkdown(reviewData);
        const outputPath = path.join(ACTION_PATH, 'review_output.md');
        fs.writeFileSync(outputPath, output);
        console.log('Saved review as markdown (GitHub API submission failed)');
      }

      // Also save the markdown version for reference
      const output = formatStructuredReviewToMarkdown(reviewData);
      const outputPath = path.join(ACTION_PATH, 'review_output.md');
      fs.writeFileSync(outputPath, output);

      // Save raw JSON for debugging/processing
      const jsonOutputPath = path.join(ACTION_PATH, 'review_output.json');
      fs.writeFileSync(jsonOutputPath, JSON.stringify(reviewData, null, 2));

      console.log(`Output saved to ${outputPath}`);
      console.log(`JSON output saved to ${jsonOutputPath}`);
    } else {
      // Simple markdown output (original behavior)
      const output = formatOutput(rawReview);
      const outputPath = path.join(ACTION_PATH, 'review_output.md');
      fs.writeFileSync(outputPath, output);

      console.log('Review completed successfully!');
      console.log(`Output saved to ${outputPath}`);
    }
  } catch (error) {
    console.error('Error during review:', error.message);
    process.exit(1);
  }
}

// Run
main();
