# Contributing

Thanks for helping. Bug reports with the tool name, the channel and the error text (without tokens) are the most useful contribution.

## Set up

```bash
npm install
npm run build
npm test
npm run smoke
```

Node.js 22.13 or newer. Tests run offline: platform calls go through a mocked `fetch`, webhook tests use recorded bodies in `test/fixtures`. Please do not add tests that need the network or real tokens.

## Guidelines

- Platform endpoints and body shapes must match the official documentation (developers.facebook.com, core.telegram.org/bots/api). Link the page in the pull request. If you cannot confirm something, say so and add it to the Limits section of the README.
- Messaging rules (windows, tags, limits) live in [messaging-rules](https://github.com/Pinlyx/messaging-rules); change them there, with a source.
- Never log or return a token. Errors that include platform text must go through the redaction helpers in `src/channels/http.ts`.
- Keep dependencies minimal and native-free.
- Add a test for every new tool or request shape, and run `npm run typecheck` before opening the pull request.
