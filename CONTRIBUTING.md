# Contributing to SASBench

SASBench is proprietary software (see [LICENSE](LICENSE)), so code contributions are not accepted. These contributions are welcome:

| Contribution | Where |
|---|---|
| A radio that works with SASBench | Pull request to [RADIOS.md](RADIOS.md) |
| A radio that does not work, or only partly works | [Radio compatibility report](https://github.com/paulmataruso/SASBench/issues/new?template=radio_report.yml) |
| A bug | [Bug report](https://github.com/paulmataruso/SASBench/issues/new?template=bug_report.yml) |
| A security vulnerability | Privately, as described in [SECURITY.md](SECURITY.md) |

Pull requests that change anything other than `RADIOS.md` will be closed. If you have found a bug and know the fix, describe it in a bug report.

## Adding a radio to the compatibility list

[Adding a radio](RADIOS.md#adding-a-radio) in RADIOS.md has the steps. In short:

1. Test the radio against SASBench yourself.
2. Add one row to the table in `RADIOS.md`, sorted by vendor and then radio, listing only the behaviours you saw work.
3. Add a notes section if other testers need to know something to get it working.
4. Open a pull request and fill in the checklist.

Leave out anything that identifies a specific unit or site: serial numbers, IP addresses, coordinates, private keys and passwords. Wire-log exports attached to a pull request should have these removed too.

## Contribution terms

By opening a pull request, you confirm that the information in it is your own test result, and you agree that it may be published and distributed as part of SASBench under the SASBench license.
