# Deploying the harvester

One command, once you have SSH access to a Virginia host:

```sh
ssh <user>@<host> 'curl -fsSL https://raw.githubusercontent.com/lyra-protocol/lyra-core/main/deploy/setup.sh | bash'
```

## Why it is safe on a shared box

This can run on a host already serving another project without affecting it:

| Concern | How it is handled |
|---|---|
| User isolation | Dedicated `lyra` system user, `nologin` shell |
| Filesystem | Everything under `/opt/lyra`; `ProtectSystem=strict`, `ProtectHome=true` |
| Network | **Opens no ports.** Outbound only — Hyperliquid's API |
| Web server | Touches no nginx/apache config, no certificates, no vhosts |
| Resources | Capped at `MemoryMax=1G`, `CPUQuota=50%` — cannot starve a co-tenant |
| Privileges | `NoNewPrivileges`, no capabilities, restricted syscalls |
| Node | Installed only if absent; an existing Node is never downgraded |

The only writable path is `/opt/lyra/data`.

## Why it restarts forever

`Restart=always`. A gap in the dataset cannot be backfilled — Hyperliquid serves
current positions only, so an hour offline is an hour lost permanently. Coming
back up matters more than failing loudly.

## After deployment

```sh
sudo systemctl status lyra-harvester
sudo tail -f /opt/lyra/data/harvest.log
```

Expect roughly, within the first hour: 1,500+ addresses discovered, 10,000+ open
positions tracked, and a steady trickle of closures — each of which is a position
that was closed or liquidated, the most informative event this dataset captures.
