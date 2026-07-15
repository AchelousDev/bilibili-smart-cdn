# Bilibili Smart CDN

A Tampermonkey userscript that improves Bilibili high-bitrate and 4K playback with smart CDN selection and adaptive media prefetching.

## Install

[Install Bilibili Smart CDN](https://raw.githubusercontent.com/AchelousDev/bilibili-smart-cdn/main/Bilibili-CDN-Smart-Selector.user.js)

Tampermonkey should open the installation page automatically.

## Features

- Smart Bilibili CDN selection
- Adaptive video and audio prefetching
- Seek-aware media baseline reset
- Automatic cancellation of outdated prefetch tasks
- Reduced unnecessary repeated downloading
- Designed for high-bitrate and 4K playback

## Requirements

- Tampermonkey
- A Chromium-based browser such as Microsoft Edge or Google Chrome

## Usage

1. Install the userscript using the link above.
2. Open a Bilibili video or bangumi page.
3. Select the desired playback quality.
4. The script will run automatically.

## Notes

- Adaptive prefetching may increase bandwidth usage, especially when watching 4K videos.
- The current version prefetches additional media while playback is paused.
- CDN availability and Bilibili player behavior may change over time.
- This project is not affiliated with or endorsed by Bilibili.

## Status

Current version: **v0.9.1 Beta**

Tested with:

- Microsoft Edge
- Tampermonkey
- Bilibili 4K video playback
- Manual seeking
- Seek during active prefetching
- Adaptive video and audio top-up behavior

## Reporting Issues

Please include the following when reporting a problem:

- Browser and version
- Userscript manager and version
- Video type: regular video or bangumi
- Selected playback quality
- Relevant `[BiliSmartCDN]` console logs

## License

MIT License
