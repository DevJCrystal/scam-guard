# Contributing to ScamGuard

Thanks for your interest in contributing! This guide covers the basics.

## Getting Started

1. Fork the repo and clone your fork
2. Load the extension in Chrome: `chrome://extensions` → Developer mode → Load unpacked
3. Make your changes and test locally
4. Submit a pull request

## Development Setup

The Chrome extension files (popup, background, content scripts) require no build step — edit the files directly and reload the extension.

For Appwrite functions, each lives in `functions/<name>/` with its own `package.json`. Run `npm install` inside the function directory if you're testing locally.

## Code Style

- 2-space indentation (see `.editorconfig`)
- ES modules (`import`/`export`) in Appwrite functions
- Plain script tags in the extension (no bundler)
- Use `const` by default, `let` when reassignment is needed

## Submitting Changes

1. Create a feature branch: `git checkout -b my-feature`
2. Make focused, small commits
3. Test the extension locally (load unpacked, click through the UI)
4. Open a PR with a clear description of what changed and why

## What to Work On

- Check the [Issues](../../issues) tab for open tasks
- Bug fixes and documentation improvements are always welcome
- For larger features, open an issue first to discuss the approach

## Appwrite Functions

If you modify a function in `functions/`, note that:

- Each function has a `.env.example` listing required environment variables
- Functions run on Node.js 25 (`node-25` runtime) in Appwrite Cloud
- Use `node-appwrite` SDK v14.x
- Functions are deployed via the Appwrite CLI (see README for commands)

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behaviour
- Chrome version and OS

## License

By contributing, you agree that your contributions will be licensed under the [GNU GPL v3](LICENSE).
