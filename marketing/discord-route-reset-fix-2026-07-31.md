**Fixed: route settings and prices resetting**

@Mariaklinga @Kat the Fox @A Ferg — thank you, this was a real bug and your descriptions are what pinned it down. It's fixed and goes out in the next deploy.

What was happening: every world advances a week on a timer, and committing that week briefly locks your airline. If you saved a fare, a frequency or a new route inside that window, the save was rejected — but the game kept showing your change as though it had worked. It only snapped back when the following week landed, which is why it felt random, and why you'd usually notice it as an unexplained loss rather than as a failed save.

Kat, your "it only happens while I change it" was the giveaway. The only way to hit this was to be actively editing in the seconds before a tick.

Two things changed:

- A save that gets rejected is now retried automatically against the new week. In almost every case your change simply goes through and you'll never know it happened.
- If a save genuinely can't be applied, the game now tells you why and puts the real value back on screen, instead of leaving you looking at a number the server never accepted.

Separately, the same collision could make your airline sit out a week entirely — no revenue, no costs, nothing in that week's results. Fixed too: the week is now recalculated for you rather than skipped. If you've ever had a week come back mysteriously flat, that was probably this.

Keep the reports coming. This one was found entirely from yours.
