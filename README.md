# AI Code Reviewer

A reusable GitHub Action that automatically reviews Pull Requests using AI models via [OpenRouter](https://openrouter.ai/). Model-agnostic - use Claude, GPT-4, Gemini, Llama, or any model available on OpenRouter.

## Features

- **Model Agnostic**: Use any AI model available on OpenRouter
- **Reusable**: Host once, use across all your repositories
- **Customizable**: Configure system prompts, review focus areas, and more
- **Automatic Reviews**: Triggers on PR open, sync, and reopen

## Quick Start

### Using the Action in Your Repository

Create `.github/workflows/ai-review.yml` in your repository:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: AI Code Review
        uses: YOUR_USERNAME/ai-code-reviewer@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Replace `YOUR_USERNAME/ai-code-reviewer` with your published action's path.

## Setup

### 1. Get an OpenRouter API Key

1. Go to [OpenRouter](https://openrouter.ai/)
2. Sign up or log in
3. Navigate to [API Keys](https://openrouter.ai/keys)
4. Create a new API key

### 2. Add the Secret to Your Repository

1. Go to your GitHub repository → **Settings** → **Secrets and variables** → **Actions**
2. Add a new repository secret:
   - Name: `OPENROUTER_API_KEY`
   - Value: Your OpenRouter API key

## Configuration Options

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `openrouter_api_key` | Yes | - | Your OpenRouter API key |
| `github_token` | Yes | - | GitHub token for posting comments |
| `model` | No | `anthropic/claude-3.5-sonnet` | AI model to use |
| `system_prompt` | No | - | Override the entire system prompt |
| `custom_prompt` | No | - | Additional instructions appended to the prompt |
| `review_focus` | No | - | Comma-separated focus areas |
| `temperature` | No | `0.3` | Model temperature (0-1) |
| `max_diff_size` | No | `100000` | Max diff size in characters |
| `post_comment` | No | `true` | Whether to post review as PR comment |

### Outputs

| Output | Description |
|--------|-------------|
| `review` | The generated review content |
| `model_used` | The AI model that was used |

## Usage Examples

### Basic Usage

```yaml
- uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

### Using a Different Model

```yaml
- uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    model: 'openai/gpt-4-turbo'
```

### Custom System Prompt

```yaml
- uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    system_prompt: |
      You are a senior security engineer reviewing code for vulnerabilities.
      Focus exclusively on security issues and rate their severity.
      Ignore style and formatting issues.
```

### Focus on Specific Areas

```yaml
- uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    review_focus: 'security,performance,bugs'
```

Available focus areas:
- `security` - Security vulnerabilities and unsafe practices
- `performance` - Performance bottlenecks and inefficiencies
- `bugs` - Logic errors, edge cases, runtime issues
- `quality` - Code smells and anti-patterns
- `readability` - Code clarity and maintainability
- `testing` - Test coverage and quality
- `documentation` - Missing or outdated docs
- `architecture` - Design patterns and modularity
- `accessibility` - UI accessibility issues
- `error-handling` - Error handling and logging

### Additional Instructions

```yaml
- uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    custom_prompt: |
      Pay special attention to:
      - SQL injection vulnerabilities
      - Proper input validation
      - Error messages that might leak sensitive info
```

### Using Review Output in Subsequent Steps

```yaml
- name: AI Code Review
  id: review
  uses: YOUR_USERNAME/ai-code-reviewer@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    post_comment: 'false'

- name: Use Review Output
  run: |
    echo "Model used: ${{ steps.review.outputs.model_used }}"
    echo "Review: ${{ steps.review.outputs.review }}"
```

## Available Models

Popular models on OpenRouter:

| Provider | Model ID | Notes |
|----------|----------|-------|
| Anthropic | `anthropic/claude-3.5-sonnet` | Default, excellent for code |
| Anthropic | `anthropic/claude-3-opus` | Most capable |
| OpenAI | `openai/gpt-4-turbo` | Fast and capable |
| OpenAI | `openai/gpt-4o` | Latest GPT-4 |
| Google | `google/gemini-pro-1.5` | Good balance |
| Meta | `meta-llama/llama-3.1-70b-instruct` | Open source |
| Mistral | `mistralai/mistral-large` | European option |
| DeepSeek | `deepseek/deepseek-coder` | Code specialist |

See the full list at [OpenRouter Models](https://openrouter.ai/models).

---

## Publishing This Action

To host and reuse this action across your projects:

### Option 1: Public Repository (Recommended)

1. **Create a new GitHub repository** named `ai-code-reviewer` (or your preferred name)

2. **Push this code to the repository**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: AI Code Reviewer action"
   git remote add origin https://github.com/YOUR_USERNAME/ai-code-reviewer.git
   git push -u origin main
   ```

3. **Create a release**:
   ```bash
   git tag -a v1 -m "Release v1"
   git push origin v1
   ```

4. **Use in any repository**:
   ```yaml
   uses: YOUR_USERNAME/ai-code-reviewer@v1
   ```

### Option 2: GitHub Marketplace

1. Follow Option 1 steps first

2. Go to your repository → **Releases** → **Draft a new release**

3. Check "Publish this Action to the GitHub Marketplace"

4. Fill in the marketplace listing details

5. Publish the release

After publishing to the Marketplace, users can find and use your action more easily.

### Option 3: Private Repository (GitHub Enterprise)

For private/internal use:

1. Create a private repository with the action code

2. Reference it using the full path:
   ```yaml
   uses: YOUR_ORG/ai-code-reviewer@v1
   ```

3. Ensure the workflow has access to the private repository

---

## Repository Structure

```
ai-code-reviewer/
├── action.yml              # Action definition
├── scripts/
│   └── review.js           # Main review script
├── .github/
│   └── workflows/
│       └── pr-code-review.yml  # Example workflow
└── README.md
```

## Troubleshooting

### Review not posting

1. Check that `OPENROUTER_API_KEY` is set correctly
2. Verify the workflow has `pull-requests: write` permission
3. Check the Actions log for error messages

### API errors

1. Verify your API key is valid
2. Check your OpenRouter account has credits
3. Ensure the model ID is correct (check [OpenRouter Models](https://openrouter.ai/models))

### Diff too large

The script truncates diffs larger than 100KB by default. You can adjust this with `max_diff_size`.

## License

MIT
