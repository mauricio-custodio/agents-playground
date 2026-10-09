# Rubric: daily route problems report

A starter rubric: tune the criteria, then run `/report` again.

## Files

1. `/mnt/session/outputs/route_report.md` exists and is a Markdown report.
2. `/mnt/session/outputs/load_per_van.png` exists: a bar chart with one bar per van (VAN-01 to VAN-04) showing its planned load in kg, with each van's capacity marked, a title and labelled axes.

## Coverage

3. The report covers every route (R1, R2, R3 and R4) and every unassigned delivery: each one is either listed with its problems or explicitly stated to have none.
4. Each problem is backed by numbers from the data, such as load against capacity, planned arrival against the time window, return time against the driver's shift end, or road distance.

## Fixes

5. Each problem has one concrete fix that names the stops, routes or vans it changes.
6. Each fix shows its effect as recalculated numbers (for example the new load, arrival time or return time), not only a description.
7. No fix creates a new problem, such as moving a stop onto a van that is then over capacity, or onto a route whose driver then works past the end of the shift.

## Quality

8. The report opens with a summary of at most five lines: how many problems there are and which one is most urgent.
9. There is no placeholder text, TODO or empty section.
