# Security policy

## Supported versions

Only the latest release gets security fixes. Older versions are not patched; update by
downloading the newest release.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request:
[report a vulnerability](https://github.com/H-Khan26/sawt-sakinah/security/advisories/new)
(GitHub private vulnerability reporting). Include the version, your operating system,
the steps to reproduce and what an attacker gains.

You can expect an acknowledgement within 7 days and a first assessment within 14 days.
A confirmed issue is fixed in a new release and credited in its advisory, unless you
prefer to stay anonymous.

## Scope

- The local API the app runs on `127.0.0.1` (`sawt_sakinah/service/`), including its
  host, origin, token and request-size checks, and anything a web page or another local
  user could do through it.
- The release bundle: the zip, the helper programs it ships (ffmpeg, ffprobe, Deno) and
  how the app finds and runs them.
- The GitHub Actions workflows in `.github/workflows/` that build and publish releases.

Out of scope: bugs in upstream projects (report those upstream), YouTube changes that
break imports, and attacks that need someone who already controls your user account.
