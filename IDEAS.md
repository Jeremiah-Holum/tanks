# Steel Front: ideas

Features the owner likes and wants eventually. Not yet scheduled; see BACKLOG.md for committed work.

## Things to spend credits on
- **Camouflage and paint**
  - Per-tank camo patterns (per nation and per map theme: summer, winter, desert) that give a small camo bonus, like WoT.
  - Cosmetic paints, emblems and inscriptions.
  - The renderer already paints per nation, with seeded German camo in `src/render/tankModel.js`.
- **Crew training and skills**
  - Train the crew to 100% for credits (or gold later).
  - Crew earn XP and unlock skills: Sixth Sense (the lamp), Repairs, Camouflage, Brothers in Arms, Firefighting, Snap Shot, Smooth Ride, Deadeye.
  - The sim already has crew roles and `crewSkill`; the profile has `crewXp`.
- **Equipment**
  - Up to 3 slots per tank: Gun Rammer (−10% reload), Vertical Stabiliser (less dispersion on the move), Improved Optics (+10% view range), Camo Net (a camo bonus when stationary), Binocular Telescope (view range when still), Spall Liner, Improved Ventilation (+crew skill), and a Tank Gun Rammer or Enhanced Suspension for heavies.
  - Hook them in as stat modifiers where the sim builds tank stats from the def.
- **Garage slots**
  - A limited number of slots, with more bought for credits, so selling tanks matters.
  - Needs the Sell button, which `economy.sell` already backs.

## Related quality-of-life
- Show available vehicle XP and free XP on the tank cards in the tech tree.
- "Total XP earned" in the Service Record and the top bar.
- Free XP conversion: spend free XP on any tank's research.
