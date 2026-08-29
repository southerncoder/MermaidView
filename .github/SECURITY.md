# Security Policy

## Supported Zed Versions

This extension supports:
- **Zed v0.210.0** or later

Please keep your Zed installation updated to receive security patches.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** create a public GitHub issue
2. Send an encrypted email to the maintainer with details
3. Include steps to reproduce and impact assessment
4. We'll acknowledge receipt within 48 hours
5. A patch will be released promptly

## Security Features

This extension implements security best practices:

- **No external network calls**: Server runs locally only
- **Same-origin policy enforced**: Browser client communicates via `127.0.0.1`
- **No user data uploaded**: All processing stays on your machine
- **Vendored dependencies**: mermaid.js included locally, reducing supply chain risks

## Known Limitations

- This is an experimental extension for Zed development
- No sandboxing beyond what Zed provides
- Use caution with diagrams containing sensitive information in shared workspaces

---

**Stay secure! Always keep your tools and extensions updated.** 🔒
