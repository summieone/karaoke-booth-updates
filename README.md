# Karaoke booth — update channel

This repository is the distribution channel for karaoke booth updates. It
holds only the files a booth downloads, plus two manifests. It is written by
the publisher tool — don't edit it by hand.

| Ring    | A booth's update URL |
|---------|----------------------|
| Staging | `https://raw.githubusercontent.com/summieone/karaoke-booth-updates/main/manifest-staging.json` |
| Stable  | `https://raw.githubusercontent.com/summieone/karaoke-booth-updates/main/manifest-stable.json` |

Every manifest entry carries the file's sha256 and a URL pinned to the exact
commit that published it. GitHub caches raw files for five minutes, and
pinning means a booth can never pair a fresh manifest with a stale file.
Booths verify every checksum before replacing anything.

Rolling back is a one-line change: point `manifest-stable.json` at an earlier
release.
