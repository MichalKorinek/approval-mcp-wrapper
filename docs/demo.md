# Video demo

[Watch the video (WebM)](media/approval-mcp-demo.webm)

The demo records the actual UI and local admin API. It starts with a
pre-authenticated test session and does not demonstrate passkey or OAuth
sign-in. It uses an isolated temporary data directory, fictional contacts,
simulated MCP responses, and a sample list of push devices. No upstream or
push provider is contacted. The approval workflow, grant persistence, call
history, and their presentation in the app are real.

## Walkthrough

1. Named upstreams, descriptions, and metadata for work and personal accounts.
2. Agents, their profiles, rules, and two independent timeouts.
3. A pending message with a readable recipient name and its complete text.
4. Selecting the entire tool and approving it for one hour without recipient
   restrictions.
5. The new grant in Access and another call with a different recipient that
   does not prompt again.
6. History and a call timeline.
7. Notification devices with Test and Remove buttons. Actual system
   notification delivery is neither simulated nor recorded.

## Record the demo again

From the repository root, using Node.js 24:

```bash
npm ci
npx playwright install chromium
npm run demo:record
```

On Linux, you may need Chromium's system libraries installed with
`npx playwright install --with-deps chromium`. Recording starts a local
server on a random port and stops it when finished.

The outputs are `docs/media/approval-mcp-demo.webm` and the poster image
`docs/media/approval-mcp-demo.png`. The silent video uses an English UI,
English sample data, and English title cards. Play the WebM file in your
browser or download it.

To use an existing browser installation, set `DEMO_CHROMIUM_EXECUTABLE`;
`PLAYWRIGHT_BROWSERS_PATH` must also contain Playwright's FFmpeg installation.
Set `DEMO_OUTPUT_DIR` to save the files elsewhere. `DEMO_SPEED` is a positive
multiplier for presentation pauses, such as `0.1` for a quick walkthrough
check. The standard recording uses `1`.
