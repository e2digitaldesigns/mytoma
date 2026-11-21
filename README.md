# myToma

An agent skill that turns a talking-head take, a voice note or a script into an animated, brand-styled video.

Every shot is an HTML scene on one paused GSAP timeline. Headless Chromium seeks that timeline to each
frame's exact time, screenshots it, and pipes the frames into ffmpeg, so the same composition always
renders the same video.

Private repository. All rights reserved.

## Status

Built in steps, one pull request each:

1. Render engine: template, `renderAt(t)`, helpers, Playwright → ffmpeg
2. Sound: cue extraction, bundled sound library, mix
3. Talking-head workflow: transcription, trim, word-timed captions, face shots
4. The skill layer: `SKILL.md`, block catalogue, worked example
5. Claude app compatibility
6. Generated voice, Three.js / Lottie / D3 blocks, content profiles
