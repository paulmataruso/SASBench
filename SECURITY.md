# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use **Report a vulnerability** on the repository's [Security tab](https://github.com/paulmataruso/SASBench/security), and include:

- the SASBench version (shown at the bottom of the console's navigation rail);
- what an attacker can do, and the steps to reproduce it;
- any logs or wire-log exports that help, with private keys and passwords removed.

Please allow reasonable time for a fix before you disclose the problem publicly.

## Scope

SASBench is a lab tool meant for a trusted test network. Keep these in mind when you deploy it:

- The web console has no user accounts. Protect it with `SAS_UI_PASSWORD` and do not expose port 8080 beyond the lab network.
- The plain-HTTP SAS listener (port 8000) has no transport security by design, for radios and simulators in bring-up. Turn it off in **Settings → Listeners & TLS** when you do not need it.
- The `Open` settings profile turns off certificate and identity checks.
- The lab PKI's private keys are stored in the database in the data volume. Treat backups of that volume as secret.

Reports about these documented behaviours are still welcome if you see a way to make them safer.
