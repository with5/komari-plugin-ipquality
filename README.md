# IP Quality plugin for Komari

A [Komari](https://github.com/komari-monitor/komari) plugin that checks the quality of each node's IP address and serves the result as a snapshot API, for themes and pages. It works like the unlock-test plugin: nothing is installed on the nodes, the plugin sends a command through the Komari agent and collects the output.

The checks come from [xykt/IPQuality](https://github.com/xykt/IPQuality) (AGPL-3.0). This plugin does not contain or copy its code. It downloads the script from `https://IP.Check.Place` on the node at run time and reads its JSON output.

## What is collected

Per node and IP stack (IPv4 / IPv6): ASN and organization, country, city, time zone, whether the geo data is consistent, IP usage type per database, risk scores per database, risk factors (proxy, VPN, Tor, server, abuser, robot) with the databases that flagged each one, mail port 25 and mail provider connectivity, and the DNS blacklist summary. Streaming and AI unlock results are left out on purpose; use unlock-test for those.

## Privacy and safety

- The script runs with `-p`, so it never uploads the report to check.place.
- IP addresses are stored masked (`36.235.*.*`). The script is never run with `-f`, and the parser masks again if a full address appears.
- Nodes marked hidden in Komari are not served to the public, and error details are admin-only.
- The script runs with `-n` by default and installs nothing. The script needs `curl`, `jq`, `bc`, `nc` and `dig`; turn on **install_deps** only if you accept it installing packages on the nodes (needs root).
- One check per node at a time (lock in `/tmp`) and each stack limited to 280 s. A run covers every online node, but only a few at the same time (3 by default): nodes that never had a result go first, then the ones checked longest ago. The script sends hundreds of DNS and HTTPS queries, so by default it runs once a day.

## API

| Route | Who | |
| --- | --- | --- |
| `GET /api/plugin/ip-quality/snapshot` | public | `{status, data:{updatedAt, running, nodes:{uuid:{ipv4, ipv6, updatedAt}}}}` |
| `POST /api/plugin/ip-quality/probe` | admin | body `{clients?:[uuid]}` starts a check, `{cancel:true}` cancels it |

`running` is true while a run is in progress and `progress` is `{done, total}` (nodes). For admins the snapshot also has `error`, `activeTask` and `lastTask`. A failed run keeps the last good result.

## Settings

IP stacks (both / IPv4 / IPv6), schedule (cron, default `0 4 * * *`), nodes checked at the same time (3), check online nodes without a result when the plugin starts (on; a node that just failed is not retried for 6 hours), allow dependency install (off), and an optional list of node UUIDs.

## Development

```sh
node --test tests/     # parser and scheduler tests, no dependencies
./build.sh             # runs the tests, bumps the version, writes dist/ip-quality.zip
```

`plugin/lib/parser.js` turns the script's JSON into the stored record, `plugin/lib/probe.js` builds the node command and runs the scheduler, `plugin/script.js` registers the routes. Upload the zip in Komari's admin **Plugins** page and enable it.

Status: the node command and the parser are covered by tests against a hand-written fixture shaped like IPQuality's documented output; it has not been run against a real node yet.

## License

MIT
