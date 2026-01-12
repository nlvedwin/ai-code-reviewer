const fs = require('fs');
const https = require('https');
const path = require('path');

// Configuration from environment variables
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'anthropic/claude-3.5-sonnet';
const PR_TITLE = process.env.PR_TITLE || '';
const PR_BODY = process.env.PR_BODY || '';
const PR_NUMBER = process.env.PR_NUMBER || '';
const REPO_NAME = process.env.REPO_NAME || '';
const MAX_DIFF_SIZE = parseInt(process.env.MAX_DIFF_SIZE, 10) || 100000;
const TEMPERATURE = parseFloat(process.env.TEMPERATURE) || 0.3;
const CUSTOM_PROMPT = process.env.CUSTOM_PROMPT || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || '';
const REVIEW_FOCUS = process.env.REVIEW_FOCUS || '';
const ACTION_PATH = process.env.ACTION_PATH || process.cwd();

// OpenRouter API endpoint
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Read the PR diff from file
 */
function readDiff() {
  const diffPath = path.join(ACTION_PATH, 'pr_diff.txt');
  try {
    let diff = fs.readFileSync(diffPath, 'utf8');

    if (diff.length > MAX_DIFF_SIZE) {
      console.log(`Diff is too large (${diff.length} chars), truncating to ${MAX_DIFF_SIZE} chars`);
      diff = diff.substring(0, MAX_DIFF_SIZE) + '\n\n... [diff truncated due to size]';
    }

    return diff;
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
 * Build the prompt for code review
 */
function buildPrompt(diff) {
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
\`\`\`diff
${diff}
\`\`\`

## Your Task
Please review the code changes and provide constructive feedback. Focus on:

${focusListText}

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
 * Format the review output
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
 * Main function
 */
async function main() {
  console.log('Starting AI Code Review...');
  console.log(`Model: ${AI_MODEL}`);
  console.log(`PR: ${REPO_NAME}#${PR_NUMBER}`);
  console.log(`Temperature: ${TEMPERATURE}`);
  console.log(`Max diff size: ${MAX_DIFF_SIZE}`);

  // Validate API key
  if (!OPENROUTER_API_KEY) {
    console.error('Error: OPENROUTER_API_KEY is not set');
    process.exit(1);
  }

  // Read the diff
  const diff = readDiff();
  if (!diff) {
    console.error('Error: No diff content found');
    process.exit(1);
  }

  console.log(`Diff size: ${diff.length} characters`);

  // Build prompt
  const prompt = buildPrompt(diff);

  // Call OpenRouter API
  console.log('Calling OpenRouter API...');
  try {
    const review = await callOpenRouter(prompt);

    // Format and save output
    const output = formatOutput(review);
    const outputPath = path.join(ACTION_PATH, 'review_output.md');
    fs.writeFileSync(outputPath, output);

    console.log('Review completed successfully!');
    console.log(`Output saved to ${outputPath}`);
  } catch (error) {
    console.error('Error during review:', error.message);
    process.exit(1);
  }
}

// Run
main();
