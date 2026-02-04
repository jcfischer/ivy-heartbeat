# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ivy-heartbeat, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **jens-christian@invisible.ch**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 48 hours. We will work with you to understand and address the issue before any public disclosure.

## Scope

Security issues we care about:
- Command injection via checklist configuration
- Prompt injection through GitHub issue bodies (content filter bypass)
- Credential exposure in logs or events
- Path traversal in file operations
- Unauthorized access to the web dashboard

## Security Design

ivy-heartbeat includes several security measures:

- **Content filtering**: GitHub issue bodies are filtered for prompt injection before processing
- **Localhost-only dashboard**: Web server binds to `127.0.0.1` only
- **Credential audit trail**: All credential access is logged to the blackboard
- **Fail-open design**: Security filter errors don't block functionality but are logged
- **Injectable dependencies**: External calls (GitHub API, calendar, email) are mockable for testing

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
