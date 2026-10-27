# Radio compatibility

Radios that have been tested against SASBench and confirmed to work. Every entry comes from someone who ran the radio against SASBench themselves.

**Tested a radio?** Add it with a pull request; see [Adding a radio](#adding-a-radio). If a radio does not work, open a [radio compatibility report](https://github.com/paulmataruso/SASBench/issues/new?template=radio_report.yml) instead.

## Confirmed radios

| Vendor | Radio | Radio software | Cat. | Air interface | Connection | Verified | SASBench | Reported by |
|--------|-------|----------------|------|---------------|------------|----------|----------|-------------|
| Nokia | AirScale AMIA + ASIA + AZQC ([notes](#nokia-airscale-amia--asia--azqc)) | SBTS25R2 | B | LTE (E_UTRA) | HTTPS, no client certificate | Registration, grant and heartbeat, deregistration (105) | 1.0.0 | [paulmataruso](https://github.com/paulmataruso) |

### What the columns mean

- **Radio**: the model, or for modular systems the units that make up the tested configuration.
- **Radio software**: the software or firmware release on the radio when it was tested.
- **Connection**: how the radio reached the SAS. One of *HTTPS with a client certificate (mutual TLS)*, *HTTPS, no client certificate*, or *plain HTTP*.
- **Verified**: the behaviours that were confirmed, using these terms:
  - **Registration**: registers and receives a cbsdId.
  - **Grant and heartbeat**: receives a grant, heartbeats and is authorized to transmit.
  - **Suspension (501)**: stops transmitting on a 501 and resumes when the grant is resumed.
  - **Termination (500)**: drops a terminated grant and requests a new one.
  - **Deregistration (105)**: handles a SAS-initiated deregistration and registers again.
  - **Relinquishment**: relinquishes its grant or deregisters by itself, for example when shut down.
  - **Measurement reports**: sends the measurement reports SASBench asks for.
- **SASBench**: the SASBench version used for the test.

## Notes

### Nokia AirScale AMIA + ASIA + AZQC

- **Trust:** add the SASBench root CA and then the SAS CA in WebEM, under the shield icon, *CBRS Certificate Management › CBRS Certificates › CBRS additional CA certificates*. The **Certificates** page in SASBench walks through it and offers both files.
- **Location:** the BBU registers without installation data (no latitude, longitude or height). SASBench holds such radios at `REG_PENDING` unless the location is preloaded (**Registry → Conditional registration**) or **Settings → Registration policy → Radio sends no location** is set to *Register anyway*. The *Open* profile sets the latter.
- Tested on the *Open* settings profile.

## Adding a radio

1. Test the radio against SASBench yourself. At a minimum it should register, get a grant and heartbeat while authorized.
2. Fork this repository and edit `RADIOS.md`.
3. Add one row to the table, keeping it sorted by vendor and then radio. Use the terms from [What the columns mean](#what-the-columns-mean) for **Connection** and **Verified**, and list only what you actually saw work.
4. If there is something another tester would need to know, such as the settings you changed, certificate formats the radio wanted or quirks you hit, add a section under [Notes](#notes) and link it from the row.
5. Open a pull request. Wire-log exports or screenshots in the pull request description help, with serial numbers, private keys and passwords removed.

To update an existing entry, for example after testing newer radio software or more behaviours, edit its row the same way. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution terms.
