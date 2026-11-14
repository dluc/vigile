# Security

## Reporting a vulnerability

Please do not open a public issue or pull request for a suspected vulnerability.

Use **Security → Report a vulnerability** in this repository to send a private
report. Include the affected version or commit, the reachable surface, a minimal
reproduction, impact, and any suggested remediation. If private vulnerability
reporting is temporarily unavailable, contact the repository maintainer through
their GitHub profile and disclose no exploit details in public.

Reports are acknowledged as soon as possible. A fix is developed and reviewed
privately when disclosure before release would put running services or data at
risk. Credit is given when requested.

## Supported version

Vigile is currently pre-1.0. Security fixes are made on the current `main`
branch. Upgrade to the latest release or commit before reporting an issue that
may already have been fixed.

## Scope

Useful reports include authentication or authorization bypass, unwanted data
access or change, key disclosure, cross-site access, unsafe file handling,
injection, denial of service, and confirmed-write durability failures.

The service is local-first. Exposing it beyond a trusted machine requires API
keys and the network/TLS protections described in the README and web site.
