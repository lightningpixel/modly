# Security Policy

## Scope

Modly is designed to run locally. It is an Electron desktop application that
spawns a Python backend bound to `127.0.0.1`, and it runs AI models on the
user's own machine. Our threat model assumes:

- The user installed Modly through a supported channel: the installer published
  on the project's GitHub releases page, or a manual install following the
  README.
- The user has not installed untrusted extensions. Extensions are arbitrary
  Python code and are trusted as much as any other software the user chooses to
  install.
- The user may open and run workflow files authored by someone else. Sharing
  workflows is a normal thing to do, so a workflow is untrusted input.
- **Any web page the user has open in a browser is an untrusted caller of the
  local API.** The backend listens on loopback, but a page in the user's browser
  is on the same machine — it must not be able to read, write, or trigger
  anything through Modly.
- Model weights are downloaded from the repositories Modly ships or from
  repositories the user explicitly chooses.
- Python dependencies are at the versions Modly installs during first-run setup.

A report is in scope only if it affects a user operating within this threat
model.

## What We Consider a Vulnerability

We want to hear about issues where a reasonable user — someone who does not
install untrusted extensions — can be harmed by Modly itself.

The clearest examples:

- A **workflow file** that such a user might plausibly open and run, using only
  built-in nodes and installed extensions, that leads to code execution,
  file access outside the expected directories, or data exfiltration.
- A **web page** that, simply by being open while Modly is running, can reach
  the local API to read files, write files, or start work on the user's machine.
- An **extension manifest** that escapes its own directory, or that causes code
  outside the extension to be loaded into a privileged context.
- A flaw in the **auto-update** mechanism on the platforms where it is enabled
  (Windows and Linux; macOS updates manually): unverified or improperly verified
  update payloads, or signature checks that fail open.
- Reaching **Node or main-process privileges** from renderer content, or
  otherwise defeating the `contextIsolation` boundary between the renderer and
  the preload bridge.

When submitting a report, please include a clear description of why this is a
problem for a typical local Modly user. Reports without this context are
difficult to act on.

## What We Do Not Consider a Security Vulnerability

Please report the following through regular GitHub issues instead. Filing them
as security reports will likely cause them to be deprioritized or closed.

- **Issues that require the user to deliberately expose the backend to the
  network.** Modly binds to `127.0.0.1` and offers no option to do otherwise. If
  you put a reverse proxy or a port forward in front of it, you have chosen to
  expose it and are responsible for securing that deployment. Note that this
  exclusion does *not* cover attacks from a web page on the user's own machine —
  those need no exposure and are in scope, as described above.
- **Issues that require a specific third-party extension to be installed.**
  Extensions are third-party code. Report those to the maintainer of the
  extension.
- **Malicious content inside model weights the user chooses to download.**
  Modly fetches weights from the repository named by an extension or by the
  user. Report those to the repository host; if an extension points at a
  malicious repository, report it to that extension's maintainer.
- **Vulnerabilities that depend on dependency versions we neither ship nor
  recommend.**
- **Crashes, hangs, or memory exhaustion** from a heavy mesh, a large image, or
  a runaway workflow. Annoying, but not a security issue in our model. File a
  regular bug.
- Automated scanner output submitted without a working reproduction.

## Supported Versions

Modly is pre-1.0 (currently 0.x). Security fixes ship in the most recent
release only. Please confirm the issue on the latest version before reporting.

## Reporting

If you believe you have found an issue that falls within the scope above, please
report it privately via GitHub's
[Report a vulnerability](https://github.com/lightningpixel/modly/security/advisories/new)
feature rather than opening a public issue, discussion, or Discord message.

Please include:

- A description of the vulnerability and the affected component.
- Reproduction steps, ideally with a minimal workflow file or proof of concept.
- The Modly version, install method, and operating system.
- An explanation of how this affects a typical local user as described in the
  threat model.

We aim to acknowledge valid reports within 3 business days, and we will
coordinate a fix and a disclosure timeline with you. Reporters are credited in
the resulting advisory and in the release notes unless they prefer to remain
anonymous.
