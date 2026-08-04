# Production GitHub Actions read token

Production release verification reads one credential from:

`/etc/newme/github-actions-read.token`

The credential must be scoped only to `69755354/newme-platform`, with repository
metadata read access and GitHub Actions read access. It must not have source write,
administration, secrets, environments, deployments, or organization permissions.

The file must be a regular file, owned by `root:root`, with mode `0400` or `0600`.
Do not paste the credential into chat, tickets, shell history, CI logs, or repository
files. Create or rotate it directly in a root shell on the production server.

The release controller copies the authorization header into a temporary root-only
curl configuration under `/run`, removes that file immediately after the GitHub API
request, and unsets the shell variable. The token is never passed as a command-line
argument.
