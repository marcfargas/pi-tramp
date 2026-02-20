# Task: Architecture Review + Decomposition

Read `C:/dev/mypi/experiments/pi-tramp/DESIGN.md` and provide your architecture review.

In addition to your standard review sections, add:

## Decomposition Proposal

This is a large design. How would you decompose it into independent, manageable,
composable pieces that can be built and tested separately? For each piece:

- What it is (name + one-line description)
- What it depends on
- What it produces (interface/contract)
- Can it be tested in isolation?
- Estimated complexity (S/M/L)

Think about clean seams — where can we cut this so pieces are independently useful
and don't create a big-bang integration risk?
