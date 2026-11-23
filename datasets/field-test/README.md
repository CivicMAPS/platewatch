# PlateWatch field-test pack

Mock data to exercise every PlateWatch feature. **Not real data:** the signs are representative,
every restriction applies **at all times** (so you can test at any hour), and the plates are
fictitious. To test with real cameras, either type the plate on the confirm screen (the plate field
is always editable), or replace the plates in `02-permits.csv` / `03-hot-list.csv` with your team's
own test vehicles before importing. Checked on every build by `tests/fieldTestPack.test.ts`.

## Files and how to load them

| # | File | Load with | Gives you |
|---|---|---|---|
| 1 | `01-timed-segments.csv` | Home → Import (⇧) | 8 timed lists on real Patrol Area 10 segments (South Melbourne), names start `FT` |
| 2 | `02-permits.csv` | Home → Import (⇧) | 3 permit (allow) lists, 6 permits |
| 3 | `03-hot-list.csv` | Home → Import (⇧) | Hot list `FT Officer safety`, 3 entries |
| 4 | `04-tagged-vehicles.backup.json` | Settings → Import backup → **Merge** | 2 tagged vehicles (disability, emergency) |
| — | `../copp-patrol-area-10.release.json` | Home → Import (optional, first) | All 55 Area 10 segments as "Restrictions to enter" placeholders. Rows in file 1 for a whole segment fill the matching placeholder (keeping its name); one-side rows are added beside it |

Before testing hot lists: **Settings → Officer → Officer number** (any number, e.g. `4471`).
Tagged vehicles cannot be imported as CSV (a tag is created by a dismissal); file 4 is a backup
holding only the tags, so **Merge** keeps everything else on the device.

## Timed lists (file 1)

| List | Sign | Tests |
|---|---|---|
| FT Gladstone St N 2P (RPA 7) | 2P, Permit Zone 7 excepted | Timed, not paid → 701 after 2 h; RPA 7 permit applies here; disability 2 × |
| FT Gladstone St S 2P Ticket | 2P Ticket, PayStay 338800001001, meter FTM1 | Payment check on first sighting; 701 / 702 |
| FT Buckhurst St N 1P Meter | 1P Meter, EasyPark 7001 | Payment check (EasyPark); 701 after 1 h |
| FT Buckhurst St S P5 Ticket (quick test) | P5 Ticket, PayStay 338800002001 | **Quick** paid tests: 701 after 5 min; 702 5 min after paid to |
| FT Munro St P10 (quick test) | P10 | **Quick** overstay / Dismiss offence alert tests |
| FT Woodgate St LZ 30 (statutory) | LZ 30 | Red sign: no permit pop-up, no tag; only "Emergency services vehicle" on dismissal |
| FT Normanby Rd N 2P DIS | 2P, disability permit holders only | Prescribed time: "Disability permit displayed" not offered |
| FT Normanby Rd S Police only (statutory) | P5, Police vehicles only | Red sign recognised from the description |

## Plates and what to expect

| Plate | Where held | Scan on | Expect |
|---|---|---|---|
| `PWP101` | FT RPA 7 residents (RPA 7) | FT Gladstone St N | Permit pop-up · **Active · applies here** → Exempt here |
| `PWP505` | FT RPA 5A residents | FT Gladstone St N | Permit pop-up · **Active · for another area or street** |
| `PWP606` | FT Street permits (Gladstone St) | FT Gladstone St N or S | Permit pop-up · applies here (street match) |
| `PWP303` | FT RPA 7 residents (expired 2025) | FT Gladstone St N | Permit pop-up · **Expired**, no Exempt button |
| `PWP404` | FT RPA 7 residents (from 2027) | FT Gladstone St N | Permit pop-up · **Not yet valid** |
| `PWP2F7` (read) | look-alike of permit `PWP2E7` (F·E) | link FT RPA 7 residents to the list first (Edit list → linked allow lists) | Similar permit plate sheet → "Permit plate confirmed — edit plate" or "Not a match" |
| `PWH801` | FT Officer safety (extreme) | any list | Hot list match → **Acknowledge** required before Next scan; entry log |
| `PWHB01` (read) | look-alike of hot `PWH801` (B·8) | any timed list | Hot-list verify interrupt → Same vehicle / Not the hot-list vehicle |
| `PWD111` | tagged: disability | any timed list (not LZ / Police) | "Previous disability permit vehicle — check vehicle…" → Confirmed = timed at 2 × |
| `PWE222` | tagged: emergency | any timed list | "Known emergency services vehicle — check vehicle" → Confirmed = no timer |
| any new plate, e.g. `PWT100` | — | FT Munro St | First sighting; re-scan after 10 min → **Overstay**, 701, Dismiss offence alert |
| `PWT100` then `PWT1OO` (read) | timed on the same list (O·0) | same list, while timing | **Possible earlier sighting** → Same vehicle (linked) / Different vehicle |

### Payment check walk-through (FT Buckhurst St S P5 Ticket)

1. Scan `PWT200` → first sighting → payment check: **Paid session found**, PayStay 338800002001,
   paid to = now + 2 min → Save.
2. Re-scan after 5 min → **701** (allowance exceeded, paid to may still be valid).
3. Scan `PWT201` → **No payment found** → Save → **702** at once.
4. Scan `PWT202` → paid to = now + 1 min; re-scan after 7 min (paid to + 5-min grace) → **702**,
   or 701 first if the allowance ran out first (the other shown as "Also reached").

Issue infringement is hidden in this build (EnforcementMAPS only).
