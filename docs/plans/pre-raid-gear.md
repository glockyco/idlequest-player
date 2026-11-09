# Pre-raid gear

What the roster's 72 characters can farm for gear from enemies of level 50 or less, ranked for each class, and the picks in `data/gear-picks.json` for the items whose droppers are named or rare spawns. Raid drops are out of scope. The roster and its groups are in [raid-roster.md](raid-roster.md), and how the coordinator hunts gear in [gear-acquisition.md](gear-acquisition.md).

## How the list is made

Every number comes from one script run over the content snapshot (`~/src/github.com/brynnb/idlequest-content`, called `C/` here) and the account survey. The script used `tools/lib/gear-data.mjs`, the module behind `tools/gear.mjs`, so `bun tools/gear.mjs <class> --level 60 --mob-max 50` shows the same stat score and drop sources for one class. It does not apply the raid-NPC filter or the comparison with worn gear below.

- Items. Rows of `C/data/items` with a slot, no augment or bag, a required level of 60 or less and the class and race masks of a roster character. A weapon also needs a weapon skill the class has at level 60 (`data/skill-caps.json`, caps for each class at 60). Items are scored for level 60 because the roster is leveling to 60 (raid-roster.md).
- Score. `scoreFor` in `tools/lib/gear-data.mjs`: stat weights by class group, 3 per haste percent, 8 per point of regeneration. Primary and secondary weapons rank by `weaponRatio`, base damage capped at the class group's limit for level 60 (100 for melee and hybrids, 40 for priests, 20 for casters) over delay. A two-handed weapon is judged on that ratio alone, as `tools/gear.mjs` does. Ranged weapons are not ranked, because the score has no term for them.
- Sources. `loadSources` in the same module: drops of NPCs up to level 50 with `raid_target` unset, in zones that the wiki lists and the live client has (`data/idlequest-zones.json`, `data/live-zones.json`). Zones with `min_level` above 60 or `min_status` above 0 are left out, which removes Hate Plane B only. Merchants are left out, because the roster gear pass buys those (`tools/lib/gear-plan.mjs`, `BUY_PP`).
- Farmable. An item counts when its best source needs 24 hours or less for one copy. Hours are `farmHours` divided by the zone's spawn points: respawn time over spawn chance times drop chance. Drop and spawn chances are the snapshot's, which the header of `tools/drops.mjs` calls approximate.
- Named or rare. The best source is scarce when the NPC's name starts with `#` or starts with a capital letter and has at most three spawn points, when `npc_types.rare_spawn` is set, or when a spawn group picks it with under 20% chance (the 20% and `#` tests are those of `tools/drops.mjs`). Other sources are common enemies, which the gear pass already hunts inside each group's rotation (`tools/iqd.mjs`, `dropWants`).
- Worn gear. The Equipped rows of `runs/state/account-items.json` (survey of 2026-11-09 00:54) for the 72 names of `data/roster.json`. Rows without a race take it from `runs/state/characters.json`.
- Wants. A character wants an item when its class, race and weapon skill allow it and the item beats what it wears in that slot by 4 score points (armor and jewelry, comparing with the worse of two ear, wrist or finger slots) or by 0.02 damage per delay (weapons, the margins of `tools/gear.mjs --party`). A Rogue's main hand must be piercing, as in `tools/lib/gear-plan.mjs`. A two-handed main-hand item must beat the worn main hand, plus 0.35 of the off hand for a dual wielder, and goes only to a character with an empty off hand unless the class dual wields. An off-hand weapon goes to dual wielders only (Warrior, Ranger, Monk, Bard, Rogue).
- Picks. For each class and slot the three best farmable items that at least one roster character of the class wants. A pick can score below the best item a higher-level character of the class wears, because the lower-level characters wear much less. "x5" after a pick means 5 characters of that class want it.

Haste does not stack, because the client counts only the highest worn haste (`tools/lib/gear-plan.mjs`, header). The h values in the tables show which picks carry haste. One haste item per character is worth its haste score, and the others only their stats.

## Picks by class

Score is the stat score at level 60, and weapons show damage per delay. `hN` is N percent haste and `2H` a two-handed weapon. "Best worn" is the best item of that slot among the class's roster characters. Where each item drops is in the item table below.

### Warrior

5 characters (Tagujazolu, Thalgrimm, Higraesir, Loshotin, Embrogg), levels 16 to 44.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Iksar Berserker Club 0.39 | Etched Velium War Lance 0.86 2H x5 / Weighted Velium Battle Axe 0.84 2H x5 / Charred Wooden Rod 0.84 2H x5 |
| Secondary (shield or held) | empty | Sarnak Battle Shield 77 x5 / Crustacean Shell Shield 40 x5 / Marr's Promise 34 x2 |
| Secondary (weapon) | Coldain Velium Rapier 0.26 | Paebala Warbone 0.56 x5 / Crafted Velium Warsword 0.56 x5 / Polished Velium Warsword 0.53 x5 |
| Range | empty | Wurmfire Totem 47 x5 / Idol of the Thorned 32 x5 / Stone of Morid 13 x3 |
| Head | Truesilver Mail Coif 20 | Hangman's Noose 59 h17 x5 / Skull-shaped Barbute 40 x5 / Guardian Helmet 35 x5 |
| Face | Small Bronze Mask 8 | Ruined Leather Mask 45 x5 / Darkwar Mask 30 x5 / Crystal Spider Eyes 30 x5 |
| Ear | Silver Stud 0 | Shattered Stone Earring 19 x5 / Earring of Essence 18 x5 / Orc Fang Earring 15 x5 |
| Neck | Runed Lava Pendant 15 | Guardian Choker 28 x5 / Spider Fur Collar 26 x5 / Ulthork Hide Collar 26 x5 |
| Shoulders | Small Bronze Pauldron 12 | Guardian Pauldrons 34 x5 / Tattered Mantle 31 x5 / Grim Pauldrons 30 x5 |
| Arms | Small Bronze Vambraces 12 | Crystal Chitin Armplates 42 x5 / Cobalt Vambraces 38 x5 / Guardian Arms 35 x5 |
| Back | Small Splinted Bronze Cloak 12 | Siblisian Berserker Cloak 153 h26 x5 / Shrewd Cloak of the Kin 54 x5 / Midnight Drolvarg Cloak 52 x5 |
| Wrist | Small Bronze Bracers 11 | Silver Chitin Wristband 57 x5 / Cobalt Bracer 30 x5 / Sentry Bracer 28 x5 |
| Hands | Truesilver Mail Gloves 18 | Silver Chitin Hand Wraps 95 h22 x5 / Silver Steel Gauntlets 77 x5 / Royal Velium Frosted Gauntlets 40 x5 |
| Finger | Jagged Band 11 | Djarn's Amethyst Ring 49 x5 / Adamantite Band 35 x5 / Rune Etched Wedding Band 28 x5 |
| Chest | Charred Guardian Breastplate 33 | Phase Spider Carapace 87 x5 / Royal Velium Frosted Plate 69 x5 / Ceremonial Iksar Chestplate 69 x5 |
| Legs | Small Bronze Greaves 15 | Royal Velium Frosted Greaves 51 x5 / Guardian Leggings 40 x5 / Crustacean Shell Greaves 34 x5 |
| Feet | Kobold-hide Boots 16 | Indicolite Boots 44 x5 / Crystal Chitin Boots 40 x5 / Tribal War Boots 39 x5 |
| Waist | Thick Leather Apron 12 | Runebranded Girdle 128 h27 x5 / Cracked Leather Belt 108 h18 x5 / Sash of the Dragonborn 75 h24 x5 |

### Cleric

8 characters (Ewbanaqoa, Omvoqizon, Bellowmick, Pellisande, Merriwick, Getadreth, Inagym, Elyssandre), levels 17 to 42.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Coldain Velium Morning Star 0.24 | Velium Brawl Stick 0.75 2H x1 / Drakkel Icegrinder 0.60 2H x1 / Paebala Warbone 0.56 x8 |
| Secondary (shield or held) | Charred Guardian Shield 112 | Book of Obulus 165 x8 / Crystal Chitin Shield 162 x8 / Ry`Gorr Oracle Shield 118 x8 |
| Range | Preserved Split Paw Eye 1 | Wurmfire Totem 151 x8 / Medicine Totem 61 x8 / Icy Skull 44 x8 |
| Head | Zaharn's Coronet 30 | Reliant Cap of the Kin 106 x8 / Guardian Helmet 101 x8 / Ethereal Mist Helm 76 x8 |
| Face | Small Bronze Mask 5 | Crystal Spider Eyes 105 x8 / Velium War Mask 86 x8 / Enshrouded Veil 84 x8 |
| Ear | Golden Earring 0 | Forest Loop 36 x8 / Earring of Essence 18 x8 / Batskull Earring 17 x8 |
| Neck | Etched Ivory Charm 34 | Abalone Gorget 110 x8 / Bone Amulet of Blade Turning 80 x8 / Black Alloy Medallion 79 x8 |
| Shoulders | Small Bronze Pauldron 8 | Adamantite Epaulets 88 x8 / Obulus Death Shroud 70 x8 / Meditative Blanket 54 x8 |
| Arms | Small Bronze Vambraces 8 | Withered Leather Sleeves 63 x8 / Silver Dragon Tattoo 47 x8 / Giant Scalemail Sleeves 45 x3 |
| Back | Small Splinted Bronze Cloak 8 | Siblisian Berserker Cloak 112 h26 x8 / Midnight Drolvarg Cloak 93 x8 / Shrewd Cloak of the Kin 90 x8 |
| Wrist | Small Bronze Bracers 7 | Bracelet of Swirling Smoke 66 x8 / Sentry Bracer 64 x8 / Chipped Bone Bracelet 60 x8 |
| Hands | Split Paw Hide Gloves 27 | Silver Chitin Hand Wraps 81 h22 x8 / Kylong Gauntlets 58 x8 / Crystal Chitin Gauntlets 55 x8 |
| Finger | Silver Ring 11 | Di`zok Begirding 99 x8 / Diamond Wedding Band 95 x8 / Shattered Stone Ring 55 x8 |
| Chest | Bloodstained Tunic 58 | Ethereal Mist Chestplate 235 x8 / Phase Spider Carapace 136 x8 / Guardian Robe 89 x8 |
| Legs | Small Bronze Greaves 10 | Ethereal Mist Greaves 119 x8 / Guardian Leggings 75 x8 / Withered Leather Leggings 59 x8 |
| Feet | Small Bronze Boots 8 | Golden Efreeti Boots 137 x8 / Boots of the Huntsman 90 x8 / Tribal War Boots 67 x8 |
| Waist | Small Bronze Girdle 7 | Runebranded Girdle 126 h27 x8 / Mucilaginous Girdle 80 x8 / Sash of the Dragonborn 74 h24 x8 |

### Paladin

4 characters (Hargrimol, Fisugrond, Ivelugias, Linysir), levels 16 to 20.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Deathwatch Sword 0.47 | Etched Velium War Lance 0.86 2H x2 / Weighted Velium Battle Axe 0.84 2H x2 / Charred Wooden Rod 0.84 2H x2 |
| Secondary (shield or held) | Chitin Shell Shield 26 | Crystal Chitin Shield 80 x4 / Sarnak Battle Shield 77 x4 / Seer Lore Book 64 x4 |
| Range | empty | Wurmfire Totem 103 x4 / Idol of the Thorned 32 x4 / Medicine Totem 24 x4 |
| Head | Ursa Tresses 6 | Guardian Helmet 62 x4 / Hangman's Noose 59 h17 x4 / Sentry Helmet 53 x4 |
| Face | empty | Ruined Leather Mask 68 x4 / Crystal Spider Eyes 67 x4 / Enshrouded Veil 57 x4 |
| Ear | Silver Stud 0 | Shattered Stone Earring 27 x4 / Forest Loop 19 x4 / Earring of Essence 18 x4 |
| Neck | Fishbone Necklace 7 | Black Alloy Medallion 43 x4 / Abalone Gorget 42 x4 / Sebilite Scale Neckguard 33 x4 |
| Shoulders | empty | Obulus Death Shroud 47 x4 / Meditative Blanket 39 x4 / Adamantite Epaulets 37 x4 |
| Arms | Blackened Iron Armplates 9 | Crystal Chitin Armplates 42 x4 / Guardian Arms 42 x4 / Netted Kelp Sleeves 39 x4 |
| Back | Sleek Black Cape 9 | Siblisian Berserker Cloak 153 h26 x4 / White Bear Pelt Cloak 102 x4 / Midnight Drolvarg Cloak 79 x4 |
| Wrist | Small Cloth Wristband 2 | Silver Chitin Wristband 57 x4 / Sentry Bracer 49 x4 / Golden Bracer 38 x4 |
| Hands | Blackened Alloy Gloves 12 | Silver Chitin Hand Wraps 95 h22 x4 / Crystal Chitin Gauntlets 58 x4 / Dark Mail Gauntlets 45 x4 |
| Finger | Copper Band 0 | Diamond Wedding Band 52 x4 / Di`zok Begirding 49 x4 / Djarn's Amethyst Ring 49 x4 |
| Chest | Dwarven Ringmail Tunic 25 | Phase Spider Carapace 131 x4 / Guardian Robe 77 x4 / Netted Kelp Tunic 74 x4 |
| Legs | Blackened Iron Legplates 11 | Valorium Greaves 54 x4 / Guardian Leggings 54 x4 / Royal Velium Frosted Greaves 51 x4 |
| Feet | Blackened Iron Boots 8 | Golden Efreeti Boots 69 x4 / Tribal War Boots 59 x4 / Boots of the Huntsman 58 x4 |
| Waist | Black Alloy Girdle 17 | Runebranded Girdle 141 h27 x4 / Cracked Leather Belt 121 h18 x4 / Sash of the Dragonborn 75 h24 x4 |

### Ranger

5 characters (Arwendrel, Gaezikrus, Imorymu, Mishebrol, Logresaerk), levels 17 to 18.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Fine Steel Great Staff 0.25 | Weighted Velium Battle Axe 0.84 2H x5 / Charred Wooden Rod 0.84 2H x5 / Forged Velium Battle Axe 0.83 2H x5 |
| Secondary (shield or held) | Wooden Shield 8 | Crystal Chitin Shield 80 x5 / Sarnak Battle Shield 77 x5 / Seer Lore Book 64 x5 |
| Secondary (weapon) | empty | Paebala Warbone 0.56 x5 / Crafted Velium Warsword 0.56 x5 / Fayguard Parrying Dagger 0.53 x5 |
| Range | empty | Wurmfire Totem 103 x5 / Idol of the Thorned 32 x5 / Medicine Totem 24 x5 |
| Head | Ruined Scaled Coif 11 | Hangman's Noose 59 h17 x5 / Sentry Helmet 53 x5 / Crystal Chitin Circlet 41 x5 |
| Face | Soft Wicker Mask 3 | Ruined Leather Mask 68 x5 / Crystal Spider Eyes 67 x5 / Enshrouded Veil 57 x5 |
| Ear | empty | Shattered Stone Earring 27 x5 / Forest Loop 19 x5 / Earring of Essence 18 x5 |
| Neck | Bamboo Splint Neckguard 8 | Black Alloy Medallion 43 x5 / Sebilite Scale Neckguard 33 x5 / Glowing Bone Collar 33 x5 |
| Shoulders | Ringmail Mantle 8 | Obulus Death Shroud 47 x5 / Imbued Granite Spauldors 45 x5 / Meditative Blanket 39 x5 |
| Arms | Reinforced Rhino Arm Guards 8 | Yeti Fur-Lined Sleeves 68 x5 / Crystal Chitin Armplates 42 x5 / Netted Kelp Sleeves 39 x5 |
| Back | Sleek Black Cape 9 | Siblisian Berserker Cloak 153 h26 x5 / Midnight Drolvarg Cloak 79 x5 / Shrewd Cloak of the Kin 79 x5 |
| Wrist | Raw-hide Wristbands 5 | Silver Chitin Wristband 57 x5 / Sentry Bracer 49 x5 / Golden Bracer 38 x5 |
| Hands | Blackened Alloy Gloves 12 | Silver Chitin Hand Wraps 95 h22 x5 / Crystal Chitin Gauntlets 58 x5 / Dark Mail Gauntlets 45 x5 |
| Finger | Antiqued Silver Band 3 | Diamond Wedding Band 52 x5 / Di`zok Begirding 49 x5 / Djarn's Amethyst Ring 49 x5 |
| Chest | Reinforced Rhino Chest Guard 14 | Phase Spider Carapace 131 x5 / Guardian Robe 77 x5 / Netted Kelp Tunic 74 x5 |
| Legs | Barbed Legplates 14 | Sentry Leggings 48 x5 / Netted Kelp Pantaloons 46 x5 / Ry`Gorr Chain Leggings 28 x5 |
| Feet | Ringmail Boots 8 | Golden Efreeti Boots 69 x5 / Tribal War Boots 59 x5 / Boots of the Huntsman 58 x5 |
| Waist | Blackened Iron Waistband 8 | Runebranded Girdle 141 h27 x5 / Cracked Leather Belt 121 h18 x5 / Sash of the Dragonborn 75 h24 x5 |

### Shadow Knight

4 characters (Vexmorrath, Gygekrian, Kimorili, Muvelemoru), levels 17 to 18.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Two Handed Sword 0.27 | Etched Velium War Lance 0.86 2H x1 / Weighted Velium Battle Axe 0.84 2H x1 / Charred Wooden Rod 0.84 2H x1 |
| Secondary (shield or held) | Round Shield 9 | Crystal Chitin Shield 80 x4 / Sarnak Battle Shield 77 x4 / Seer Lore Book 64 x4 |
| Range | empty | Wurmfire Totem 103 x4 / Idol of the Thorned 32 x4 / Medicine Totem 24 x4 |
| Head | Stone Circlet 9 | Guardian Helmet 62 x4 / Hangman's Noose 59 h17 x4 / Sentry Helmet 53 x4 |
| Face | Burynai Hide Mask 9 | Ruined Leather Mask 68 x4 / Crystal Spider Eyes 67 x4 / Enshrouded Veil 57 x4 |
| Ear | Golden Earring 0 | Shattered Stone Earring 27 x4 / Forest Loop 19 x4 / Earring of Essence 18 x4 |
| Neck | Blue Wicker Gorget 6 | Black Alloy Medallion 43 x4 / Abalone Gorget 42 x4 / Sebilite Scale Neckguard 33 x1 |
| Shoulders | Burynai Hide Shoulder Pads 10 | Obulus Death Shroud 47 x4 / Imbued Granite Spauldors 45 x1 / Meditative Blanket 39 x4 |
| Arms | Soft Wicker Sleeves 6 | Crystal Chitin Armplates 42 x4 / Guardian Arms 42 x4 / Netted Kelp Sleeves 39 x4 |
| Back | Sleek Black Cape 9 | Siblisian Berserker Cloak 153 h26 x4 / Midnight Drolvarg Cloak 79 x4 / Shrewd Cloak of the Kin 79 x4 |
| Wrist | Legionnaire's Bracer 5 | Silver Chitin Wristband 57 x4 / Sentry Bracer 49 x4 / Golden Bracer 38 x4 |
| Hands | Blackened Alloy Gloves 12 | Silver Chitin Hand Wraps 95 h22 x4 / Crystal Chitin Gauntlets 58 x4 / Dark Mail Gauntlets 45 x4 |
| Finger | Antiqued Silver Band 3 | Diamond Wedding Band 52 x4 / Di`zok Begirding 49 x4 / Djarn's Amethyst Ring 49 x4 |
| Chest | Raw-hide Tunic 12 | Phase Spider Carapace 131 x4 / Guardian Robe 77 x4 / Netted Kelp Tunic 74 x4 |
| Legs | Icy Greaves 14 | Guardian Leggings 54 x4 / Royal Velium Frosted Greaves 51 x4 / Sentient Greaves 49 x4 |
| Feet | Reinforced Rhino Boots 8 | Golden Efreeti Boots 69 x4 / Boots of Dark Passage 67 x4 / Tribal War Boots 59 x4 |
| Waist | Blackened Iron Waistband 8 | Runebranded Girdle 141 h27 x4 / Cracked Leather Belt 121 h18 x4 / Sash of the Dragonborn 75 h24 x4 |

### Druid

5 characters (Felowynna, Fushyny, Kiabriala, Mugrudraeth, Hythavor), levels 15 to 20.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Bargynn's Digger 0.27 | Velium Brawl Stick 0.75 2H x1 / Paebala Warbone 0.56 x5 / Runewood Great Staff 0.55 2H x1 |
| Secondary (shield or held) | Blackened Sapphire 5 | Book of Obulus 165 x5 / Crystal Chitin Shield 162 x5 / Ry`Gorr Oracle Shield 118 x5 |
| Range | empty | Wurmfire Totem 151 x5 / Medicine Totem 61 x5 / Icy Skull 44 x5 |
| Head | empty | Reliant Cap of the Kin 106 x5 / Nightshade Wreath 74 x5 / Platinum Tiara 71 x5 |
| Face | empty | Crystal Spider Eyes 105 x5 / Velium War Mask 86 x5 / Enshrouded Veil 84 x5 |
| Ear | Mithril Earring 0 | Forest Loop 36 x5 / Earring of Essence 18 x5 / Batskull Earring 17 x5 |
| Neck | Small Raw-hide Gorget 3 | Bone Amulet of Blade Turning 80 x5 / Black Alloy Medallion 79 x5 / Ornate Velium Pendant 68 x5 |
| Shoulders | Krode's Shawl 26 | Obulus Death Shroud 70 x5 / Braided Ivy Cords 60 x5 / Meditative Blanket 54 x5 |
| Arms | Small Raw-hide Sleeves 4 | Withered Leather Sleeves 63 x5 / Silver Dragon Tattoo 47 x5 / Ulthork Hide Arms 42 x5 |
| Back | Small Raw-hide Cloak 4 | Siblisian Berserker Cloak 112 h26 x5 / Midnight Drolvarg Cloak 93 x5 / Shrewd Cloak of the Kin 90 x5 |
| Wrist | Small Raw-hide Wristbands 3 | Vermiculated Bracelet 126 x5 / Bracelet of Swirling Smoke 66 x5 / Chipped Bone Bracelet 60 x5 |
| Hands | empty | Silver Chitin Hand Wraps 81 h22 x5 / Crystal Chitin Gauntlets 55 x5 / Withered Leather Gloves 43 x5 |
| Finger | Bloodstone Ring 0 | Di`zok Begirding 99 x5 / Diamond Wedding Band 95 x5 / Shattered Stone Ring 55 x5 |
| Chest | Small Cloth Shirt 4 | Guardian Robe 89 x5 / Shroud of Nature 86 x5 / Mithril-Runed Tunic 66 x5 |
| Legs | Small Raw-hide Leggings 5 | Mud Covered Leather Leggings 62 x5 / Withered Leather Leggings 59 x5 / Netted Kelp Pantaloons 29 x5 |
| Feet | Soft Leather Boots 4 | Golden Efreeti Boots 137 x5 / Withered Leather Boots 67 x5 / Crystal Lined Slippers 49 x5 |
| Waist | empty | Runebranded Girdle 126 h27 x5 / Mucilaginous Girdle 80 x5 / Sash of the Dragonborn 74 h24 x5 |

### Monk

4 characters (Tovrenalis, Figrothe, Ibaegrix, Litilor), levels 16 to 17.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Fine Steel Morning Star 0.21 | Tranquil Staff 0.97 2H x4 / Imbued Fighters Staff 0.95 2H x4 / Charred Wooden Rod 0.84 2H x4 |
| Secondary (shield or held) | empty | Glowing Torch 11 x4 / Crude Stein 10 x4 / Wooden Shield 8 x4 |
| Secondary (weapon) | Bamboo Wakizashi Bo 0.16 | Stave of Shielding 0.61 x4 / Adamantite Club 0.60 x4 / Paebala Warbone 0.56 x4 |
| Range | empty | Wurmfire Totem 47 x4 / Idol of the Thorned 32 x4 / Gem of Rage 9 x4 |
| Head | Cat Skull Cap 7 | Hangman's Noose 59 h17 x4 / Crown of the Froglok Kings 30 x4 / Crown of the Forlorn 24 x4 |
| Face | Soft Wicker Mask 3 | Ruined Leather Mask 45 x4 / Crystal Spider Eyes 30 x4 / Enshrouded Veil 29 x4 |
| Ear | Silver Stud 0 | Shattered Stone Earring 19 x4 / Earring of Essence 18 x4 / Orc Fang Earring 15 x4 |
| Neck | Raw-hide Gorget 5 | Spider Fur Collar 26 x4 / Ulthork Hide Collar 26 x4 / Glowing Bone Collar 20 x4 |
| Shoulders | Soft Wicker Shoulderpads 5 | Imbued Granite Spauldors 45 x4 / Tattered Mantle 31 x4 / Spiroc Feather Spaulders 28 x4 |
| Arms | Raw-hide Sleeves 6 | Sleeves of the Ancients 27 x4 / Dusty Rusted Vambraces 25 x4 / Netted Kelp Sleeves 19 x4 |
| Back | Raw-hide Cloak 6 | Siblisian Berserker Cloak 153 h26 x4 / Shrewd Cloak of the Kin 54 x4 / Midnight Drolvarg Cloak 52 x4 |
| Wrist | Raw-hide Wristbands 5 | Silver Chitin Wristband 57 x4 / Tar goo strands 21 x4 / Dusty Rusted Shackles 21 x4 |
| Hands | Blue Wicker Gloves 8 | Silver Chitin Hand Wraps 95 h22 x4 / Iksar Scaled Gloves 26 x4 / Netted Kelp Gloves 21 x4 |
| Finger | Copper Band 0 | Djarn's Amethyst Ring 49 x4 / Adamantite Band 35 x4 / Rune Etched Wedding Band 28 x4 |
| Chest | Raw-hide Tunic 12 | Phase Spider Carapace 87 x4 / Tree Weave 48 x4 / Netted Kelp Tunic 41 x4 |
| Legs | Dark Muslin Leggings 11 | Mud Covered Leather Leggings 52 x4 / Netted Kelp Pantaloons 26 x4 / Prowling Leopard Leggings 20 x4 |
| Feet | Pit Fighter Anklewraps 4 | Shiverback-hide Boots 32 x4 / Footpads of the Tiger 32 x4 / Netted Kelp Lined Shoes 24 x4 |
| Waist | Dark Muslin Sash 8 | Runebranded Girdle 128 h27 x4 / Cracked Leather Belt 108 h18 x4 / Sash of the Dragonborn 75 h24 x4 |

### Bard

5 characters (Ugfeu, Gaesylo, Ifekirk, Kilogruth, Manograth), levels 17 to 42.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Coldain Velium Rapier 0.26 | Guardians Mace 0.58 x5 / Paebala Warbone 0.56 x5 / Crafted Velium Warsword 0.56 x5 |
| Secondary (shield or held) | Hand Drum 0 | Crystal Chitin Shield 80 x5 / Sarnak Battle Shield 77 x5 / Seer Lore Book 64 x5 |
| Secondary (weapon) | Coldain Velium Rapier 0.26 | Guardians Mace 0.58 x5 / Paebala Warbone 0.56 x5 / Crafted Velium Warsword 0.56 x5 |
| Range | empty | Wurmfire Totem 103 x5 / Idol of the Thorned 32 x5 / Medicine Totem 24 x5 |
| Head | Ringmail Coif 11 | Guardian Helmet 62 x5 / Hangman's Noose 59 h17 x5 / Sentry Helmet 53 x5 |
| Face | Bronze Mask 8 | Ruined Leather Mask 68 x5 / Crystal Spider Eyes 67 x5 / Enshrouded Veil 57 x5 |
| Ear | Opalline Earring 3 | Shattered Stone Earring 27 x5 / Forest Loop 19 x5 / Earring of Essence 18 x5 |
| Neck | Ringmail Neckguard 8 | Black Alloy Medallion 43 x5 / Abalone Gorget 42 x5 / Sebilite Scale Neckguard 33 x5 |
| Shoulders | Bloodstained Mantle 15 | Obulus Death Shroud 47 x5 / Imbued Granite Spauldors 45 x5 / Meditative Blanket 39 x5 |
| Arms | Burynai Hide Sleeves 12 | Imbrued Platemail Vambraces 57 x5 / Crystal Chitin Armplates 42 x5 / Guardian Arms 42 x5 |
| Back | Bamboo Splint Cape 9 | Siblisian Berserker Cloak 153 h26 x5 / Midnight Drolvarg Cloak 79 x5 / Shrewd Cloak of the Kin 79 x5 |
| Wrist | Ruined Scaled Bracelet 8 | Silver Chitin Wristband 57 x5 / Sentry Bracer 49 x5 / Bracelet of Swirling Smoke 44 x5 |
| Hands | Ringmail Gloves 9 | Silver Chitin Hand Wraps 95 h22 x5 / Crystal Chitin Gauntlets 58 x5 / Dark Mail Gauntlets 45 x5 |
| Finger | Jagged Band 11 | Diamond Wedding Band 52 x5 / Di`zok Begirding 49 x5 / Djarn's Amethyst Ring 49 x5 |
| Chest | Charred Guardian Breastplate 33 | Phase Spider Carapace 131 x5 / Guardian Robe 77 x5 / Netted Kelp Tunic 74 x5 |
| Legs | Reinforced Rhino Leggings 9 | Guardian Leggings 54 x5 / Royal Velium Frosted Greaves 51 x5 / Sentry Leggings 48 x5 |
| Feet | Dwarven Work Boots 20 | Golden Efreeti Boots 69 x5 / Tribal War Boots 59 x5 / Boots of the Huntsman 58 x5 |
| Waist | Thick Leather Apron 12 | Runebranded Girdle 141 h27 x5 / Cracked Leather Belt 121 h18 x5 / Sash of the Dragonborn 75 h24 x5 |

### Rogue

4 characters (Pivorandel, Eskarn, Hudelaerk, Liaganor), levels 15 to 22.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Bargynn's Digger 0.27 | Trakasaur's Tooth 0.50 x4 / Small Dragonbone Shard 0.50 x1 / Blood Point 0.48 x4 |
| Secondary (shield or held) | empty | Crustacean Shell Shield 40 x4 / Scute Shield 32 x4 / Chetari Bonecrafted Shield 32 x1 |
| Secondary (weapon) | Fine Steel Rapier 0.22 | Paebala Warbone 0.56 x4 / Crafted Velium Warsword 0.56 x4 / Polished Velium Warsword 0.53 x4 |
| Range | empty | Wurmfire Totem 47 x4 / Idol of the Thorned 32 x4 / Gem of Rage 9 x4 |
| Head | Large Ringmail Coif 11 | Hangman's Noose 59 h17 x4 / Kylong War Helm 31 x4 / Crown of the Froglok Kings 30 x4 |
| Face | Soft Wicker Mask 3 | Ruined Leather Mask 45 x4 / Crystal Spider Eyes 30 x4 / Enshrouded Veil 29 x4 |
| Ear | Silver Stud 0 | Shattered Stone Earring 19 x4 / Earring of Essence 18 x4 / Orc Fang Earring 15 x4 |
| Neck | Stone Collar 8 | Spider Fur Collar 26 x4 / Ulthork Hide Collar 26 x4 / Sentry Choker 22 x4 |
| Shoulders | Blackened Alloy Spaulder 11 | Imbued Granite Spauldors 45 x3 / Tattered Mantle 31 x4 / Spiroc Feather Spaulders 28 x4 |
| Arms | Blackened Iron Armplates 9 | Yeti Fur-Lined Sleeves 45 x4 / Crystal Chitin Armplates 42 x4 / Woven Shadow Vambraces 30 x4 |
| Back | Bamboo Splint Cape 9 | Siblisian Berserker Cloak 153 h26 x4 / Shrewd Cloak of the Kin 54 x4 / Midnight Drolvarg Cloak 52 x4 |
| Wrist | Small Ringmail Bracelet 8 | Silver Chitin Wristband 57 x4 / Bracer of Midnight 29 x4 / Sentry Bracer 28 x4 |
| Hands | Blackened Alloy Gloves 12 | Silver Chitin Hand Wraps 95 h22 x4 / Crystal Chitin Gauntlets 40 x4 / Sentry Gauntlets 31 x4 |
| Finger | Copper Band 0 | Djarn's Amethyst Ring 49 x4 / Adamantite Band 35 x4 / Rune Etched Wedding Band 28 x4 |
| Chest | Truesilver Mail Shirt 30 | Phase Spider Carapace 87 x4 / Woven Shadow Chestplate 78 x4 / Ceremonial Iksar Chestplate 69 x4 |
| Legs | Blackened Iron Legplates 11 | Sentry Leggings 33 x4 / Woven Shadow Greaves 29 x4 / Ry`Gorr Chain Leggings 28 x4 |
| Feet | Leather Boots 6 | Crystal Chitin Boots 40 x4 / Tribal War Boots 39 x4 / Woven Shadow Boots 35 x4 |
| Waist | Black Alloy Girdle 17 | Runebranded Girdle 128 h27 x4 / Cracked Leather Belt 108 h18 x4 / Sash of the Dragonborn 75 h24 x4 |

### Shaman

8 characters (Qigaa, Ulgarthon, Kragvold, Fymadrin, Gykrovelael, Idraene, Esszrak, Lashybraend), levels 14 to 41.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Coldain Velium Great Staff 0.28 | Granite Face Grinder 0.81 2H x3 / Velium Brawl Stick 0.75 2H x3 / Rune Etched Icewurm Fang 0.63 x8 |
| Secondary (shield or held) | Wooden Shield 5 | Book of Obulus 165 x8 / Crystal Chitin Shield 162 x8 / Ry`Gorr Oracle Shield 118 x8 |
| Range | Preserved Split Paw Eye 1 | Wurmfire Totem 151 x8 / Medicine Totem 61 x8 / Icy Skull 44 x8 |
| Head | Savant's Cap 46 | Reliant Cap of the Kin 106 x8 / Nightshade Wreath 74 x8 / Platinum Tiara 71 x8 |
| Face | Iron Visor 3 | Crystal Spider Eyes 105 x8 / Velium War Mask 86 x8 / Enshrouded Veil 84 x8 |
| Ear | Bloodstone Earring 1 | Forest Loop 36 x8 / Earring of Essence 18 x8 / Batskull Earring 17 x8 |
| Neck | Black Alloy Medallion 79 | Ivory Imbued Collar 82 x7 / Bone Amulet of Blade Turning 80 x7 / Black Alloy Medallion 79 x7 |
| Shoulders | Kunzar Mantle 41 | Chokidai Hide Spaulders 101 x8 / Obulus Death Shroud 70 x8 / Meditative Blanket 54 x8 |
| Arms | Burynai Hide Sleeves 5 | Yeti Fur-Lined Sleeves 95 x8 / Withered Leather Sleeves 63 x8 / Silver Dragon Tattoo 47 x8 |
| Back | Raw-hide Cloak 4 | Siblisian Berserker Cloak 112 h26 x8 / Midnight Drolvarg Cloak 93 x8 / Shrewd Cloak of the Kin 90 x8 |
| Wrist | Reinforced Rhino Wrist Guard 4 | Rune Etched Bracer 82 x3 / Bracelet of Swirling Smoke 66 x8 / Sentry Bracer 64 x8 |
| Hands | Ringmail Gloves 6 | Silver Chitin Hand Wraps 81 h22 x8 / Kylong Gauntlets 58 x8 / Crystal Chitin Gauntlets 55 x8 |
| Finger | Gold Ring 0 | Di`zok Begirding 99 x8 / Diamond Wedding Band 95 x8 / Shattered Stone Ring 55 x8 |
| Chest | Bloodstained Tunic 58 | Phase Spider Carapace 136 x8 / Frozen Shadow Chain Chestguard 92 x8 / Guardian Robe 89 x8 |
| Legs | Reinforced Rhino Leggings 6 | Withered Leather Leggings 59 x8 / Sentry Leggings 51 x8 / Netted Kelp Pantaloons 29 x8 |
| Feet | Raw-hide Boots 4 | Golden Efreeti Boots 137 x8 / Boots of the Huntsman 90 x3 / Tribal War Boots 67 x8 |
| Waist | Thick Leather Apron 8 | Runebranded Girdle 126 h27 x8 / Mucilaginous Girdle 80 x8 / Sash of the Dragonborn 74 h24 x8 |

### Necromancer

7 characters (Zharovane, Zulvethra, Vorthessa, Nyxalor, Gukraemaer, Kuzidres, Evandrith), levels 17 to 20.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Mithril Quill 0.21 | Velium Brawl Stick 0.50 2H x1 / Runewood Great Staff 0.50 2H x1 / Chetari Wardstaff 0.50 2H x1 |
| Secondary (shield or held) | Fire Beetle Eye 0 | Hand of the Reaper 197 x7 / Seer Lore Book 187 x7 / Book of Obulus 165 x7 |
| Range | empty | Wurmfire Totem 147 x7 / Frosted Gem 64 x7 / Shardwurm Eye 56 x7 |
| Head | Dusty Burlap Hood 2 | Runed Cowl 121 x7 / Nightshade Wreath 74 x7 / Gem Encrusted Circlet 69 x7 |
| Face | Dusty Burlap Veil 1 | Crystal Spider Eyes 101 x7 / Velium War Mask 86 x7 / Enshrouded Veil 81 x7 |
| Ear | Golden Earring 0 | Batskull Earring 56 x7 / Obsidian Bead Hoop 36 x7 / Golden Ear Stud 34 x7 |
| Neck | Dusty Burlap Collar 1 | Black Alloy Medallion 79 x7 / Petrified Erudite Heart Amulet 73 x7 / Sarnak Arcane Fetish 68 x7 |
| Shoulders | Damask Amice 2 | Squallsurge Shawl 55 x7 / Meditative Blanket 54 x7 / Mantle of the Elder Serpent 53 x7 |
| Arms | Dusty Burlap Sleeves 2 | Netted Kelp Sleeves 76 x7 / Loam Encrusted Sleeves 68 x7 / Embroidered Black Sleeves 33 x7 |
| Back | Cloth Cape 2 | Siblisian Berserker Cloak 107 h26 x7 / Midnight Drolvarg Cloak 87 x7 / Shrewd Cloak of the Kin 85 x7 |
| Wrist | Dusty Burlap Wristband 1 | Golden Bracer 84 x7 / Skullchip Bracelet 65 x7 / Ring of the Ancients 62 x7 |
| Hands | Dusty Burlap Gloves 2 | Silver Chitin Hand Wraps 81 h22 x7 / Spider Fur Gloves 73 x7 / Impskin Gloves 68 x7 |
| Finger | Bloodstone Ring 0 | Di`zok Begirding 98 x7 / Diamond Wedding Band 95 x7 / Ring of the Frost Spiders 72 x7 |
| Chest | Gossamer Robe 8 | Guardian Robe 152 x7 / Loam Encrusted Robe 148 x7 / Sentry Robe 133 x7 |
| Legs | Dusty Burlap Pants 3 | Netted Kelp Pantaloons 77 x7 / Loam Encrusted Pantaloons 51 x7 / Flayed Coldain-Skin Leggings 45 x7 |
| Feet | Dusty Burlap Sandals 2 | Golden Efreeti Boots 137 x7 / Decisive Boots of the Kin 115 x7 / Red Silk Lined Boots 91 x7 |
| Waist | Damask Sash 2 | Runebranded Girdle 123 h27 x7 / Sash of the Dragonborn 74 h24 x7 / Netted Kelp Sash 64 x7 |

### Wizard

4 characters (Fizzwackle, Figrelun, Kiasiby, Hufiazun), levels 15 to 18.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Dagger of Frost 0.40 | Velium Brawl Stick 0.50 2H x1 / Runewood Great Staff 0.50 2H x1 / Chetari Wardstaff 0.50 2H x1 |
| Secondary (shield or held) | Fire Beetle Eye 0 | Seer Lore Book 187 x4 / Book of Obulus 165 x4 / Drachnid Thyxl 104 x4 |
| Range | empty | Wurmfire Totem 147 x4 / Frosted Gem 64 x4 / Shardwurm Eye 56 x4 |
| Head | Dark Muslin Cap 5 | Runed Cowl 121 x4 / Nightshade Wreath 74 x4 / Gem Encrusted Circlet 69 x4 |
| Face | Dusty Burlap Veil 1 | Crystal Spider Eyes 101 x4 / Velium War Mask 86 x4 / Enshrouded Veil 81 x4 |
| Ear | Silver Stud 0 | Batskull Earring 56 x4 / Obsidian Bead Hoop 36 x4 / Golden Ear Stud 34 x4 |
| Neck | Copper Amulet 0 | Black Alloy Medallion 79 x4 / Petrified Erudite Heart Amulet 73 x4 / Sarnak Arcane Fetish 68 x4 |
| Shoulders | Dusty Burlap Shawl 1 | Squallsurge Shawl 55 x4 / Meditative Blanket 54 x4 / Mantle of the Elder Serpent 53 x4 |
| Arms | empty | Netted Kelp Sleeves 76 x4 / Loam Encrusted Sleeves 68 x4 / Embroidered Black Sleeves 33 x4 |
| Back | empty | Siblisian Berserker Cloak 107 h26 x4 / Midnight Drolvarg Cloak 87 x4 / Shrewd Cloak of the Kin 85 x4 |
| Wrist | empty | Golden Bracer 84 x4 / Skullchip Bracelet 65 x4 / Ring of the Ancients 62 x4 |
| Hands | Dusty Burlap Gloves 2 | Silver Chitin Hand Wraps 81 h22 x4 / Spider Fur Gloves 73 x4 / Impskin Gloves 68 x4 |
| Finger | Silver Ring 0 | Di`zok Begirding 98 x4 / Diamond Wedding Band 95 x4 / Ring of the Frost Spiders 72 x4 |
| Chest | Gossamer Robe 8 | Guardian Robe 152 x4 / Loam Encrusted Robe 148 x4 / Sentry Robe 133 x4 |
| Legs | empty | Netted Kelp Pantaloons 77 x4 / Loam Encrusted Pantaloons 51 x4 / Flayed Coldain-Skin Leggings 45 x4 |
| Feet | empty | Golden Efreeti Boots 137 x4 / Decisive Boots of the Kin 115 x4 / Red Silk Lined Boots 91 x4 |
| Waist | Dusty Burlap Cord 1 | Runebranded Girdle 123 h27 x4 / Sash of the Dragonborn 74 h24 x4 / Netted Kelp Sash 64 x4 |

### Magician

4 characters (Domeyafun, Faekregux, Mashidond, Hodrydrus), levels 14 to 42.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Mithril Quill 0.21 | Velium Brawl Stick 0.50 2H x1 / Runewood Great Staff 0.50 2H x1 / Chetari Wardstaff 0.50 2H x1 |
| Secondary (shield or held) | Fire Beetle Eye 0 | Seer Lore Book 187 x4 / Book of Obulus 165 x4 / Drachnid Thyxl 104 x4 |
| Range | Preserved Split Paw Eye 1 | Wurmfire Totem 147 x4 / Frosted Gem 64 x4 / Shardwurm Eye 56 x4 |
| Head | Savant's Cap 46 | Runed Cowl 121 x4 / Nightshade Wreath 74 x4 / Gem Encrusted Circlet 69 x4 |
| Face | Moss Mask 2 | Crystal Spider Eyes 101 x4 / Velium War Mask 86 x4 / Enshrouded Veil 81 x4 |
| Ear | Silver Stud 0 | Batskull Earring 56 x4 / Obsidian Bead Hoop 36 x4 / Golden Ear Stud 34 x4 |
| Neck | Collar of Undead Protection 9 | Black Alloy Medallion 79 x4 / Petrified Erudite Heart Amulet 73 x4 / Sarnak Arcane Fetish 68 x4 |
| Shoulders | Cloth Shawl 1 | Squallsurge Shawl 55 x4 / Meditative Blanket 54 x4 / Mantle of the Elder Serpent 53 x4 |
| Arms | Cloth Sleeves 2 | Netted Kelp Sleeves 76 x4 / Loam Encrusted Sleeves 68 x4 / Embroidered Black Sleeves 33 x4 |
| Back | Molten Cloak 63 | Siblisian Berserker Cloak 107 h26 x4 / Midnight Drolvarg Cloak 87 x4 / Shrewd Cloak of the Kin 85 x4 |
| Wrist | Bracelet of Woven Grass 40 | Golden Bracer 84 x4 / Skullchip Bracelet 65 x4 / Ring of the Ancients 62 x4 |
| Hands | Impskin Gloves 68 | Silver Chitin Hand Wraps 81 h22 x4 / Spider Fur Gloves 73 x4 / Impskin Gloves 68 x3 |
| Finger | Jagged Band 5 | Di`zok Begirding 98 x4 / Diamond Wedding Band 95 x4 / Ring of the Frost Spiders 72 x4 |
| Chest | Frost Goblin Skin 9 | Apothic Robe 209 x4 / Guardian Robe 152 x4 / Loam Encrusted Robe 148 x4 |
| Legs | Gossamer Leggings 5 | Netted Kelp Pantaloons 77 x4 / Loam Encrusted Pantaloons 51 x4 / Flayed Coldain-Skin Leggings 45 x4 |
| Feet | Cloth Sandals 2 | Golden Efreeti Boots 137 x4 / Decisive Boots of the Kin 115 x4 / Red Silk Lined Boots 91 x4 |
| Waist | Drakescale Belt 8 | Runebranded Girdle 123 h27 x4 / Sash of the Dragonborn 74 h24 x4 / Netted Kelp Sash 64 x4 |

### Enchanter

5 characters (Edroun, Kidadriar, Mosiadeth, Eloquine, Hianymis), levels 15 to 42.

| Slot | Best worn | Picks, best first |
| --- | --- | --- |
| Primary | Giant Snake Fang 0.19 | Velium Brawl Stick 0.50 2H x2 / Runewood Great Staff 0.50 2H x2 / Chetari Wardstaff 0.50 2H x2 |
| Secondary (shield or held) | Torch 0 | Seer Lore Book 187 x5 / Book of Obulus 165 x5 / Drachnid Thyxl 104 x5 |
| Range | Preserved Split Paw Eye 1 | Wurmfire Totem 147 x5 / Frosted Gem 64 x5 / Shardwurm Eye 56 x5 |
| Head | Savant's Cap 46 | Runed Cowl 121 x5 / Nightshade Wreath 74 x5 / Gem Encrusted Circlet 69 x5 |
| Face | Glowing Mask 2 | Crystal Spider Eyes 101 x5 / Velium War Mask 86 x5 / Enshrouded Veil 81 x5 |
| Ear | Opalline Earring 2 | Batskull Earring 56 x5 / Obsidian Bead Hoop 36 x5 / Golden Ear Stud 34 x5 |
| Neck | Split Paw Tooth Necklace 4 | Black Alloy Medallion 79 x5 / Petrified Erudite Heart Amulet 73 x5 / Sarnak Arcane Fetish 68 x5 |
| Shoulders | empty | Neriad Shawl 116 x5 / Squallsurge Shawl 55 x5 / Meditative Blanket 54 x5 |
| Arms | Gossamer Sleeves 4 | Netted Kelp Sleeves 76 x5 / Loam Encrusted Sleeves 68 x5 / Embroidered Black Sleeves 33 x5 |
| Back | Spectral Shroud 8 | Siblisian Berserker Cloak 107 h26 x5 / Midnight Drolvarg Cloak 87 x5 / Shrewd Cloak of the Kin 85 x5 |
| Wrist | Dark Boned Bracelet 3 | Golden Bracer 84 x5 / Skullchip Bracelet 65 x5 / Ring of the Ancients 62 x5 |
| Hands | Gossamer Gloves 4 | Silver Chitin Hand Wraps 81 h22 x5 / Spider Fur Gloves 73 x5 / Impskin Gloves 68 x5 |
| Finger | Gold Ring 0 | Di`zok Begirding 98 x5 / Diamond Wedding Band 95 x5 / Ring of the Frost Spiders 72 x5 |
| Chest | Gossamer Robe 8 | Guardian Robe 152 x5 / Loam Encrusted Robe 148 x5 / Sentry Robe 133 x5 |
| Legs | Gossamer Leggings 5 | Netted Kelp Pantaloons 77 x5 / Loam Encrusted Pantaloons 51 x5 / Flayed Coldain-Skin Leggings 45 x5 |
| Feet | empty | Golden Efreeti Boots 137 x5 / Decisive Boots of the Kin 115 x5 / Red Silk Lined Boots 91 x5 |
| Waist | Gossamer Sash 3 | Runebranded Girdle 123 h27 x5 / Sash of the Dragonborn 74 h24 x5 / Netted Kelp Sash 64 x5 |

## Items and where they drop

The 195 items that reach a top three. A filled "Entry" marks an item that `data/gear-picks.json` lists. An empty entry means a common enemy (the gear pass covers it where it lies in a rotation zone) or a scarce dropper whose copies need more than 250 hours.

| Item | Dropper (level) | Zone | Drop % | Spawn % | Points | Respawn s | Hours per copy | Scarce because | Wanted by | Entry |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- |
| Abalone Gorget | a freshwater shark (15) | Lake Rathetear | 20 | 100 | 2 | 400 | 0.3 | common enemy | 25 |  |
| Adamantite Band | a reanimated hand (39) | The Ruins of Old Guk | 25 | 34 | 1 | 1740 | 5.7 | common enemy | 72 |  |
| Adamantite Club | #The Spectre Sepulcher (50) | The Howling Stones | 25 | 50 | 2 | 1260 | 1.4 | named | 4 | gear-adamantite-club |
| Adamantite Epaulets | a ghoul cavalier (36) | The Ruins of Old Guk | 75 | 30 | 1 | 1740 | 2.1 | rare flag | 25 | gear-adamantite-epaulets |
| Apothic Robe | a haunted chest (50) | Plane of Hate | 3.2 | 100 | 8 | 640 | 0.7 | common enemy | 4 |  |
| Batskull Earring | a Chetari guard (48) | Dragon Necropolis | 2.4 | 100 | 30 | 640 | 0.2 | common enemy | 59 |  |
| Black Alloy Medallion | a Pickclaw Slayspell (21) | The Liberated Citadel of Runnyeye | 2.3 | 100 | 4 | 640 | 1.9 | common enemy | 67 |  |
| Blood Point | a crypt spectre (50) | The Howling Stones | 20 | 33 | 4 | 1260 | 1.3 | common enemy | 9 |  |
| Bone Amulet of Blade Turning | sentry of Sathir (46) | Karnor's Castle | 5.0 | 34 | 9 | 1440 | 2.6 | common enemy | 20 |  |
| Book of Obulus | spectral turnkey (47) | Karnor's Castle | 25 | 13 | 11 | 1440 | 1.1 | spawn 13% | 41 | gear-book-of-obulus |
| Boots of Dark Passage | #Guard Falldrryn (46) | Kael Drakkel | 5.0 | 100 | 1 | 520 | 2.9 | named | 4 | gear-boots-of-dark-passage |
| Boots of the Huntsman | Grand Huntsman Darral (49) | Icewell Keep | 100 | 100 | 1 | 21000 | 5.8 | named | 38 | gear-boots-of-the-huntsman |
| Bracelet of Swirling Smoke | an arena spectator (45) | Kael Drakkel | 7.0 | 100 | 3 | 1800 | 2.4 | common enemy | 26 |  |
| Bracer of Midnight | Wenglawks Kkeak (43) | Kael Drakkel | 20 | 100 | 1 | 520 | 0.7 | named | 4 | gear-bracer-of-midnight |
| Braided Ivy Cords | Bracken Underbrush (18) | The Lesser Faydark | 50 | 50 | 1 | 640 | 0.7 | named | 15 | gear-braided-ivy-cords |
| Ceremonial Iksar Chestplate | Crusader Zoglic (45) | Trakanon's Teeth | 100 | 2.0 | 6 | 600 | 1.4 | spawn 2% | 41 | gear-ceremonial-iksar-chestplate |
| Charred Wooden Rod | a tundra yeti (32) | The Dreadlands | 0.3 | 100 | 13 | 640 | 4.2 | common enemy | 17 |  |
| Chetari Bonecrafted Shield | a Chetari guard (48) | Dragon Necropolis | 2.8 | 100 | 30 | 640 | 0.2 | common enemy | 36 |  |
| Chetari Wardstaff | a Chetari Deathbinder (50) | Dragon Necropolis | 2.7 | 50 | 4 | 640 | 3.3 | common enemy | 10 |  |
| Chipped Bone Bracelet | The Great Oowomp (34) | Timorous Deep | 2.0 | 100 | 1 | 640 | 8.9 | named | 67 |  |
| Chokidai Hide Spaulders | a Chokidai Sniffer (45) | Chardok | 1.0 | 100 | 10 | 640 | 1.8 | common enemy | 8 |  |
| Cobalt Bracer | myconid warrior (50) | The Ruins of Sebilis | 1.0 | 100 | 11 | 640 | 1.6 | common enemy | 5 |  |
| Cobalt Vambraces | froglok zol knight (43) | The Ruins of Sebilis | 3.0 | 80 | 6 | 640 | 1.2 | common enemy | 5 |  |
| Cracked Leather Belt | Lost Spirit (38) | The Hole | 25 | 100 | 1 | 1200 | 1.3 | named | 31 | gear-cracked-leather-belt |
| Crafted Velium Warsword | a Chetari guard (48) | Dragon Necropolis | 0.0 | 100 | 30 | 640 | 16.5 | common enemy | 27 |  |
| Crown of the Forlorn | King Gragnar (24) | The Warrens | 6.0 | 100 | 1 | 640 | 3.0 | named | 45 | gear-crown-of-the-forlorn |
| Crown of the Froglok Kings | the froglok king (47) | The Ruins of Old Guk | 75 | 20 | 1 | 1740 | 3.2 | rare flag | 68 | gear-crown-of-the-froglok-kings |
| Crude Stein | Bouncer Mrang (36) | Oggok | 100 | 100 | 1 | 640 | 0.2 | named | 27 | gear-crude-stein |
| Crustacean Shell Greaves | an Othmir Warrior (42) | Cobaltscar | 1.3 | 100 | 6 | 640 | 2.2 | common enemy | 25 |  |
| Crustacean Shell Shield | an Othmir Warrior (42) | Cobaltscar | 1.3 | 100 | 6 | 640 | 2.2 | common enemy | 47 |  |
| Crystal Chitin Armplates | a crystalline hunter (48) | Velketor's Labyrinth | 2.7 | 15 | 58 | 900 | 1.0 | spawn 15% | 48 | gear-crystal-chitin-armplates |
| Crystal Chitin Boots | a crystalline hunter (48) | Velketor's Labyrinth | 2.7 | 15 | 58 | 900 | 1.0 | spawn 15% | 48 | gear-crystal-chitin-boots |
| Crystal Chitin Circlet | a crystalline hunter (48) | Velketor's Labyrinth | 2.7 | 15 | 58 | 900 | 1.0 | spawn 15% | 71 | gear-crystal-chitin-circlet |
| Crystal Chitin Gauntlets | a crystalline hunter (48) | Velketor's Labyrinth | 2.7 | 15 | 58 | 900 | 1.0 | spawn 15% | 48 | gear-crystal-chitin-gauntlets |
| Crystal Chitin Shield | Crystal Fang (47) | Velketor's Labyrinth | 50 | 25 | 1 | 900 | 2.0 | named | 44 | gear-crystal-chitin-shield |
| Crystal Lined Slippers | #a crystal purifier (35) | The Crystal Caverns | 90 | 17 | 1 | 1200 | 2.2 | named, rare flag, spawn 17% | 67 | gear-crystal-lined-slippers |
| Crystal Spider Eyes | Crystal Eyes (47) | Velketor's Labyrinth | 65 | 20 | 1 | 900 | 1.9 | named, rare flag | 72 | gear-crystal-spider-eyes |
| Dark Mail Gauntlets | a ghoul sentinel (42) | The Ruins of Old Guk | 75 | 30 | 1 | 1740 | 2.1 | rare flag | 26 | gear-dark-mail-gauntlets |
| Darkwar Mask | a revultant rat (49) | Plane of Hate | 20 | 100 | 9 | 640 | 0.1 | common enemy | 5 |  |
| Decisive Boots of the Kin | Count Darchen (48) | Skyshrine | 13 | 100 | 1 | 640 | 1.4 | named | 20 | gear-decisive-boots-of-the-kin |
| Di`zok Begirding | a Di`zok Conscript (47) | Chardok | 0.2 | 100 | 14 | 640 | 5.7 | common enemy | 71 |  |
| Diamond Wedding Band | Nosja (32) | The Tower of Frozen Shadow | 12 | 100 | 1 | 400 | 0.9 | named | 71 | gear-diamond-wedding-band |
| Djarn's Amethyst Ring | Efreeti Lord Djarn (50) | Nagafen's Lair | 25 | 25 | 1 | 640 | 2.8 | named, rare flag | 72 | gear-djarn-s-amethyst-ring |
| Drachnid Thyxl | a dread widow (48) | The Dreadlands | 85 | 25 | 1 | 640 | 0.8 | common enemy | 20 |  |
| Drakkel Icegrinder | a frost giant scout (36) | The Great Divide | 1.2 | 100 | 11 | 640 | 1.3 | common enemy | 17 |  |
| Dusty Rusted Shackles | a pyre golem (45) | The Howling Stones | 4.2 | 50 | 15 | 1260 | 1.1 | common enemy | 35 |  |
| Dusty Rusted Vambraces | a pyre golem (45) | The Howling Stones | 4.2 | 50 | 15 | 1260 | 1.1 | common enemy | 35 |  |
| Earring of Essence | Soothsayer Dregzak (35) | Frontier Mountains | 24 | 49 | 1 | 640 | 1.5 | named | 72 | gear-earring-of-essence |
| Embroidered Black Sleeves | a ghoul ritualist (34) | The Ruins of Old Guk | 25 | 30 | 1 | 1740 | 6.4 | rare flag | 46 |  |
| Enshrouded Veil | a mortiferous golem (50) | The Howling Stones | 0.6 | 50 | 9 | 1260 | 13.7 | common enemy | 72 |  |
| Etched Velium War Lance | a Chetari guard (48) | Dragon Necropolis | 0.2 | 100 | 30 | 640 | 2.5 | common enemy | 8 |  |
| Ethereal Mist Chestplate | Cleric of Innoruuk (49) | Plane of Hate | 3.5 | 100 | 9 | 640 | 0.6 | common enemy | 8 |  |
| Ethereal Mist Greaves | Cleric of Innoruuk (49) | Plane of Hate | 3.5 | 100 | 9 | 640 | 0.6 | common enemy | 8 |  |
| Ethereal Mist Helm | Cleric of Innoruuk (49) | Plane of Hate | 3.5 | 100 | 9 | 640 | 0.6 | common enemy | 8 |  |
| Fayguard Parrying Dagger | #The Crypt Keeper (50) | The Howling Stones | 75 | 34 | 1 | 1260 | 1.4 | named | 5 | gear-fayguard-parrying-dagger |
| Flayed Coldain-Skin Leggings | Bjoskhua Blackfist (48) | Kael Drakkel | 50 | 25 | 1 | 520 | 1.2 | named | 41 | gear-flayed-coldain-skin-leggings |
| Footpads of the Tiger | #Snowbeast (40) | The Stonebrunt Mountains | 100 | 100 | 1 | 640 | 0.2 | named | 4 | gear-footpads-of-the-tiger |
| Forest Loop | a forest giant verdant (42) | The Burning Wood | 2.7 | 100 | 8 | 80 | 0.1 | common enemy | 72 |  |
| Forged Velium Battle Axe | a Chetari guard (48) | Dragon Necropolis | 0.1 | 100 | 30 | 640 | 5.4 | common enemy | 13 |  |
| Frosted Gem | a snow dervish (30) | Eastern Wastes | 4.7 | 100 | 10 | 640 | 0.4 | common enemy | 41 |  |
| Frozen Shadow Chain Chestguard | #an angry chef (34) | The Tower of Frozen Shadow | 2.0 | 50 | 8 | 400 | 1.4 | named, rare flag | 17 | gear-frozen-shadow-chain-chestguard |
| Gem Encrusted Circlet | Overseer Miklek (40) | Frontier Mountains | 25 | 34 | 5 | 640 | 0.4 | common enemy | 20 |  |
| Gem of Rage | Reivaj the Battlerager (50) | Kael Drakkel | 30 | 34 | 1 | 520 | 1.4 | named, rare flag | 30 | gear-gem-of-rage |
| Giant Scalemail Sleeves | #Sergeant Breldimer (45) | Kael Drakkel | 33 | 100 | 5 | 520 | 0.1 | named | 31 | gear-giant-scalemail-sleeves |
| Glowing Bone Collar | an ogre priestess (27) | The Western Plains of Karana | 13 | 25 | 1 | 640 | 5.7 | common enemy | 71 |  |
| Glowing Torch | Tisella (12) | Lavastorm Mountains | 100 | 2.0 | 1 | 360 | 5.0 | named, rare flag, spawn 2% | 57 |  |
| Golden Bracer | a crypt spectre (50) | The Howling Stones | 59 | 33 | 4 | 1260 | 0.4 | common enemy | 66 |  |
| Golden Ear Stud | a gnoll embalmer (16) | Lake Rathetear | 4.2 | 34 | 4 | 400 | 1.9 | rare flag | 59 | gear-golden-ear-stud |
| Golden Efreeti Boots | Efreeti Lord Djarn (50) | Nagafen's Lair | 75 | 25 | 1 | 640 | 0.9 | named, rare flag | 67 | gear-golden-efreeti-boots |
| Granite Face Grinder | spectral duke (49) | The Ruins of Sebilis | 3.6 | 25 | 4 | 640 | 5.0 | common enemy | 11 |  |
| Grim Pauldrons | Dreadlord Fanrik (50) | Trakanon's Teeth | 100 | 2.0 | 6 | 600 | 1.4 | spawn 2% | 21 | gear-grim-pauldrons |
| Guardian Arms | a Gargoyle Guardian (37) | Skyshrine | 2.2 | 50 | 2 | 640 | 7.9 | common enemy | 26 |  |
| Guardian Choker | a Gargoyle Guardian (37) | Skyshrine | 2.2 | 50 | 2 | 640 | 7.9 | common enemy | 25 |  |
| Guardian Helmet | a Gargoyle Guardian (37) | Skyshrine | 2.2 | 50 | 2 | 640 | 7.9 | common enemy | 26 |  |
| Guardian Leggings | a Golem Guardian (38) | Skyshrine | 25 | 50 | 3 | 640 | 0.5 | common enemy | 26 |  |
| Guardian Pauldrons | a Gargoyle Guardian (37) | Skyshrine | 2.2 | 50 | 2 | 640 | 7.9 | common enemy | 26 |  |
| Guardian Robe | a Golem Guardian (38) | Skyshrine | 1.9 | 50 | 3 | 640 | 6.4 | common enemy | 68 |  |
| Guardians Mace | #The Skeleton Sepulcher (50) | The Howling Stones | 25 | 25 | 3 | 1260 | 1.9 | named | 9 | gear-guardians-mace |
| Hand of the Reaper | Bile Sentinel (48) | The Howling Stones | 6.3 | 25 | 2 | 1260 | 11.2 | named | 7 | gear-hand-of-the-reaper |
| Hangman's Noose | Hangman (48) | Trakanon's Teeth | 100 | 2.0 | 6 | 600 | 1.4 | spawn 2% | 72 | gear-hangman-s-noose |
| Icy Skull | #Icecrafter Leyreon (46) | Kael Drakkel | 25 | 100 | 2 | 520 | 0.3 | named | 59 | gear-icy-skull |
| Idol of the Thorned | Chief RokGus (38) | Frontier Mountains | 8.3 | 50 | 1 | 640 | 4.3 | named | 72 |  |
| Iksar Scaled Gloves | Grachnist the Destroyer (32) | The Warsliks Woods | 7.5 | 50 | 2 | 640 | 2.4 | named | 46 | gear-iksar-scaled-gloves |
| Imbrued Platemail Vambraces | a haunted chest (50) | Plane of Hate | 25 | 100 | 8 | 640 | 0.1 | common enemy | 5 |  |
| Imbued Fighters Staff | frenzied pox scarab (50) | The Ruins of Sebilis | 6.0 | 16 | 1 | 640 | 18.5 | spawn 16% | 4 | gear-imbued-fighters-staff |
| Imbued Granite Spauldors | a ratman warrior (47) | The Hole | 0.5 | 100 | 8 | 640 | 4.4 | common enemy | 23 |  |
| Impskin Gloves | Kindle (26) | Solusek's Eye | 15 | 25 | 2 | 640 | 2.4 | named, rare flag | 58 | gear-impskin-gloves |
| Indicolite Boots | a haunted chest (50) | Plane of Hate | 3.0 | 100 | 8 | 640 | 0.7 | common enemy | 5 |  |
| Ivory Imbued Collar | a Shai`din Soldier (47) | Chardok | 1.3 | 100 | 10 | 640 | 1.4 | common enemy | 7 |  |
| Kylong Gauntlets | a sepulcher skeleton (45) | The Howling Stones | 0.9 | 100 | 12 | 1260 | 3.3 | common enemy | 43 |  |
| Kylong War Helm | #The Skeleton Sepulcher (50) | The Howling Stones | 75 | 25 | 3 | 1260 | 0.6 | named | 42 | gear-kylong-war-helm |
| Loam Encrusted Pantaloons | Stonegrinder Minion (49) | The Hole | 25 | 100 | 13 | 640 | 0.1 | rare flag | 20 | gear-loam-encrusted-pantaloons |
| Loam Encrusted Robe | an elemental harvester (45) | The Hole | 0.5 | 100 | 30 | 1200 | 2.3 | common enemy | 20 |  |
| Loam Encrusted Sleeves | bejeweled elemental (49) | The Hole | 25 | 50 | 10 | 1200 | 0.3 | rare flag | 20 | gear-loam-encrusted-sleeves |
| Mantle of the Elder Serpent | #Slyder the Ancient (40) | The Stonebrunt Mountains | 50 | 100 | 1 | 640 | 0.4 | named | 25 | gear-mantle-of-the-elder-serpent |
| Marr's Promise | Tabien the Goodly (32) | The Rathe Mountains | 100 | 100 | 1 | 600 | 0.2 | named | 26 | gear-marr-s-promise |
| Medicine Totem | Blugtigin (32) | Frontier Mountains | 100 | 34 | 1 | 640 | 0.5 | named | 71 | gear-medicine-totem |
| Meditative Blanket | Titail Sinok (45) | Trakanon's Teeth | 100 | 2.0 | 6 | 600 | 1.4 | spawn 2% | 72 | gear-meditative-blanket |
| Midnight Drolvarg Cloak | a drolvarg sentry (43) | Karnor's Castle | 0.2 | 100 | 17 | 1440 | 10.7 | common enemy | 72 |  |
| Mithril-Runed Tunic | a froglok crusader (42) | The Ruins of Old Guk | 25 | 34 | 1 | 1740 | 5.7 | rare flag | 46 |  |
| Mucilaginous Girdle | #Sentient Bile (50) | The Howling Stones | 60 | 25 | 2 | 1260 | 1.2 | named | 70 | gear-mucilaginous-girdle |
| Mud Covered Leather Leggings | Lost Spirit (38) | The Hole | 25 | 100 | 1 | 1200 | 1.3 | named | 9 | gear-mud-covered-leather-leggings |
| Neriad Shawl | a neriad mistress (49) | Siren's Grotto | 10.0 | 100 | 8 | 1636 | 0.6 | common enemy | 10 |  |
| Netted Kelp Gloves | an enthralled bulthar (47) | Siren's Grotto | 0.8 | 100 | 22 | 1636 | 2.5 | common enemy | 69 |  |
| Netted Kelp Lined Shoes | an enthralled bulthar (47) | Siren's Grotto | 0.9 | 100 | 22 | 1636 | 2.4 | common enemy | 72 |  |
| Netted Kelp Pantaloons | an enthralled bulthar (47) | Siren's Grotto | 0.8 | 100 | 22 | 1636 | 2.7 | common enemy | 72 |  |
| Netted Kelp Sash | an enthralled bulthar (47) | Siren's Grotto | 0.6 | 100 | 22 | 1636 | 3.2 | common enemy | 71 |  |
| Netted Kelp Sleeves | an enthralled bulthar (47) | Siren's Grotto | 1.1 | 100 | 22 | 1636 | 1.9 | common enemy | 72 |  |
| Netted Kelp Tunic | an enthralled bulthar (47) | Siren's Grotto | 0.9 | 100 | 22 | 1636 | 2.2 | common enemy | 70 |  |
| Nightshade Wreath | Maid Issis (34) | The Castle of Mistmoore | 25 | 50 | 1 | 1720 | 3.8 | named, rare flag | 46 | gear-nightshade-wreath |
| Obsidian Bead Hoop | Singe (28) | Solusek's Eye | 75 | 34 | 1 | 640 | 0.7 | named, rare flag | 72 | gear-obsidian-bead-hoop |
| Obulus Death Shroud | dar ghoul knight (47) | The Ruins of Sebilis | 0.1 | 100 | 12 | 640 | 10.4 | common enemy | 72 |  |
| Orc Fang Earring | a Ry`Gorr clan scout (29) | Eastern Wastes | 5.0 | 100 | 5 | 640 | 0.7 | common enemy | 72 |  |
| Ornate Velium Pendant | Councilor Icelok (45) | Icewell Keep | 25 | 100 | 1 | 640 | 0.7 | named | 58 | gear-ornate-velium-pendant |
| Paebala Warbone | a Paebala warrior (47) | Dragon Necropolis | 1.7 | 100 | 3 | 640 | 3.5 | common enemy | 52 |  |
| Petrified Erudite Heart Amulet | kobold noble (38) | Nagafen's Lair | 25 | 34 | 1 | 640 | 2.1 | rare flag | 25 | gear-petrified-erudite-heart-amulet |
| Phase Spider Carapace | a phase spider (48) | Dragon Necropolis | 1.0 | 100 | 17 | 640 | 1.0 | common enemy | 47 |  |
| Platinum Tiara | a froglok tactician (45) | The Ruins of Old Guk | 25 | 30 | 1 | 1740 | 6.4 | rare flag | 46 |  |
| Polished Velium Warsword | a Chetari guard (48) | Dragon Necropolis | 0.1 | 100 | 30 | 640 | 8.1 | common enemy | 27 |  |
| Prowling Leopard Leggings | #Prowler of the Jungle (37) | The Stonebrunt Mountains | 100 | 15 | 1 | 1200 | 2.2 | named, spawn 15% | 54 | gear-prowling-leopard-leggings |
| Red Silk Lined Boots | greater spurbone (37) | The Emerald Jungle | 0.2 | 100 | 8 | 640 | 12.1 | common enemy | 20 |  |
| Reliant Cap of the Kin | Count Morin (48) | Skyshrine | 8.5 | 100 | 1 | 640 | 2.1 | named | 21 | gear-reliant-cap-of-the-kin |
| Ring of the Ancients | an ancient cyclops (32) | Southern Desert of Ro | 100 | 8.2 | 3 | 640 | 0.7 | rare flag, spawn 8% | 71 | gear-ring-of-the-ancients |
| Ring of the Frost Spiders | a Frenzied Velium Stalker (47) | Velketor's Labyrinth | 55 | 20 | 1 | 900 | 2.3 | rare flag | 20 | gear-ring-of-the-frost-spiders |
| Royal Velium Frosted Gauntlets | an Icewell Sentry (45) | Icewell Keep | 2.7 | 100 | 4 | 640 | 1.6 | common enemy | 25 |  |
| Royal Velium Frosted Greaves | an Icewell Sentry (45) | Icewell Keep | 2.7 | 100 | 4 | 640 | 1.6 | common enemy | 26 |  |
| Royal Velium Frosted Plate | an Icewell Sentry (45) | Icewell Keep | 2.7 | 100 | 4 | 640 | 1.6 | common enemy | 25 |  |
| Ruined Leather Mask | a drolvarg sentry (43) | Karnor's Castle | 0.2 | 100 | 17 | 1440 | 14.4 | common enemy | 72 |  |
| Rune Etched Bracer | a haunted chest (50) | Plane of Hate | 3.0 | 100 | 8 | 640 | 0.7 | common enemy | 3 |  |
| Rune Etched Icewurm Fang | #Oracle Zardukel (46) | Kael Drakkel | 7.7 | 100 | 2 | 520 | 0.9 | named | 8 | gear-rune-etched-icewurm-fang |
| Rune Etched Wedding Band | Daman (32) | The Tower of Frozen Shadow | 18 | 100 | 1 | 400 | 0.6 | named | 72 | gear-rune-etched-wedding-band |
| Runebranded Girdle | krup ghoul knight (47) | The Ruins of Sebilis | 0.2 | 100 | 12 | 640 | 6.5 | common enemy | 72 |  |
| Runed Cowl | a ghoul sage (37) | The Ruins of Old Guk | 25 | 34 | 1 | 1740 | 5.7 | rare flag | 25 | gear-runed-cowl |
| Runewood Great Staff | greater plaguebone (39) | The City of Mist | 1.1 | 50 | 34 | 1440 | 2.1 | common enemy | 26 |  |
| Ry`Gorr Chain Leggings | Ry`Gorr elite guard (43) | Eastern Wastes | 2.7 | 100 | 4 | 640 | 1.6 | common enemy | 43 |  |
| Ry`Gorr Oracle Shield | Oracle of Ry`Gorr (44) | Eastern Wastes | 11 | 100 | 1 | 640 | 1.6 | named | 48 | gear-ry-gorr-oracle-shield |
| Sarnak Arcane Fetish | a Shai`din Soldier (47) | Chardok | 1.3 | 100 | 10 | 640 | 1.4 | common enemy | 57 |  |
| Sarnak Battle Shield | a Shai`din Soldier (47) | Chardok | 1.3 | 100 | 10 | 640 | 1.4 | common enemy | 43 |  |
| Sash of the Dragonborn | a crypt spectre (50) | The Howling Stones | 20 | 33 | 4 | 1260 | 1.3 | common enemy | 72 |  |
| Scute Shield | Dunedigger (15) | Northern Desert of Ro | 20 | 5.0 | 1 | 640 | 17.8 | named, rare flag, spawn 5% | 47 |  |
| Sebilite Scale Neckguard | froglok ostiary (50) | The Ruins of Sebilis | 25 | 20 | 1 | 640 | 3.6 | common enemy | 30 |  |
| Seer Lore Book | A Ruby Drake (49) | Skyshrine | 2.4 | 100 | 6 | 640 | 1.2 | common enemy | 58 |  |
| Sentient Greaves | a suit of sentient armor (45) | The Wakening Land | 6.0 | 50 | 7 | 640 | 0.8 | common enemy | 4 |  |
| Sentry Bracer | a Velium Rock Sentry (33) | Skyshrine | 1.5 | 100 | 1 | 640 | 12.1 | common enemy | 43 |  |
| Sentry Choker | a Velium Rock Sentry (33) | Skyshrine | 1.5 | 100 | 1 | 640 | 12.1 | common enemy | 41 |  |
| Sentry Gauntlets | Sentry Nombole (35) | Skyshrine | 7.1 | 50 | 1 | 640 | 5.0 | named | 43 | gear-sentry-gauntlets |
| Sentry Helmet | Sentry Kale (39) | Skyshrine | 2.2 | 50 | 1 | 640 | 15.8 | named | 43 |  |
| Sentry Leggings | a Golem Sentry (32) | Skyshrine | 2.9 | 100 | 1 | 640 | 6.1 | common enemy | 43 |  |
| Sentry Robe | an Aged Golem Sentinel (43) | Skyshrine | 25 | 100 | 1 | 640 | 0.7 | common enemy | 20 |  |
| Shardwurm Eye | an ancient shardwurm (36) | The Great Divide | 1.6 | 50 | 8 | 640 | 2.7 | common enemy | 20 |  |
| Shattered Stone Earring | a scorpikis (35) | The Overthere | 0.2 | 100 | 30 | 640 | 2.8 | common enemy | 31 |  |
| Shattered Stone Ring | a scorpikis (35) | The Overthere | 0.2 | 100 | 30 | 640 | 2.8 | common enemy | 59 |  |
| Shiverback-hide Boots | a haunted chest (50) | Plane of Hate | 3.2 | 100 | 8 | 640 | 0.7 | common enemy | 4 |  |
| Shrewd Cloak of the Kin | Count Taloob (48) | Skyshrine | 55 | 100 | 1 | 640 | 0.3 | named | 72 | gear-shrewd-cloak-of-the-kin |
| Shroud of Nature | a goblin warder (32) | Mines of Nurga | 25 | 5.0 | 66 | 1050 | 0.4 | spawn 5% | 10 | gear-shroud-of-nature |
| Siblisian Berserker Cloak | froglok kor shaman (44) | The Ruins of Sebilis | 0.5 | 50 | 6 | 640 | 11.9 | common enemy | 72 |  |
| Silver Chitin Hand Wraps | a Frenzied Velium Broodling (47) | Velketor's Labyrinth | 65 | 20 | 1 | 900 | 1.9 | rare flag | 72 | gear-silver-chitin-hand-wraps |
| Silver Chitin Wristband | a Frenzied Velium Broodling (47) | Velketor's Labyrinth | 35 | 20 | 1 | 900 | 3.6 | rare flag | 31 | gear-silver-chitin-wristband |
| Silver Dragon Tattoo | Nojas Blackfist (49) | Kael Drakkel | 55 | 33 | 1 | 520 | 0.8 | named | 70 | gear-silver-dragon-tattoo |
| Silver Steel Gauntlets | Vkjor (50) | Kael Drakkel | 25 | 33 | 1 | 520 | 1.8 | named | 5 | gear-silver-steel-gauntlets |
| Skull-shaped Barbute | the ghoul lord (47) | The Ruins of Old Guk | 75 | 33 | 1 | 1740 | 2.0 | rare flag | 25 | gear-skull-shaped-barbute |
| Skullchip Bracelet | Miner Bordakn (38) | Frontier Mountains | 25 | 25 | 1 | 640 | 2.8 | named | 38 | gear-skullchip-bracelet |
| Sleeves of the Ancients | Varithyx (28) | Frontier Mountains | 25 | 20 | 1 | 640 | 3.6 | named | 35 | gear-sleeves-of-the-ancients |
| Small Dragonbone Shard | a Paebala warrior (47) | Dragon Necropolis | 3.4 | 100 | 3 | 640 | 1.7 | common enemy | 3 |  |
| Spider Fur Collar | an Icepaw kobold (46) | Velketor's Labyrinth | 8.3 | 100 | 38 | 900 | 0.1 | common enemy | 70 |  |
| Spider Fur Gloves | a blizzard hunter (49) | Velketor's Labyrinth | 5.0 | 25 | 62 | 900 | 0.3 | common enemy | 20 |  |
| Spiroc Feather Spaulders | #a spiroc roostmaster (41) | Timorous Deep | 75 | 100 | 1 | 7200 | 2.7 | named | 13 | gear-spiroc-feather-spaulders |
| Squallsurge Shawl | Undertow (49) | Kedge Keep | 30 | 100 | 1 | 25200 | 23.3 | named, rare flag | 20 |  |
| Stave of Shielding | a Di`zok Conscript (47) | Chardok | 0.2 | 100 | 14 | 640 | 5.7 | common enemy | 12 |  |
| Stone of Morid | a goblin fanatic (34) | Frontier Mountains | 10.0 | 100 | 24 | 640 | 0.1 | common enemy | 14 |  |
| Tar goo strands | a tar goo (40) | The Wakening Land | 7.5 | 100 | 12 | 640 | 0.2 | common enemy | 52 |  |
| Tattered Mantle | Gullerback (47) | The Burning Wood | 50 | 5.0 | 4 | 66 | 0.2 | spawn 5% | 49 | gear-tattered-mantle |
| Trakasaur's Tooth | Trakanasaur Rex (50) | Trakanon's Teeth | 100 | 2.0 | 4 | 600 | 2.1 | spawn 2% | 4 | gear-trakasaur-s-tooth |
| Tranquil Staff | skeletal warlord (41) | Karnor's Castle | 1.0 | 7.7 | 29 | 1440 | 17.9 | spawn 8% | 4 | gear-tranquil-staff |
| Tree Weave | a mountain giant patriarch (44) | The Dreadlands | 7.0 | 6.3 | 20 | 640 | 2.0 | spawn 6% | 34 | gear-tree-weave |
| Tribal War Boots | a Di`zok Legionnaire (49) | Chardok | 0.2 | 100 | 5 | 640 | 18.5 | common enemy | 43 |  |
| Ulthork Hide Arms | an ulthork warrior (36) | Eastern Wastes | 1.2 | 100 | 5 | 640 | 2.8 | common enemy | 47 |  |
| Ulthork Hide Collar | an ulthork man o war (42) | Eastern Wastes | 1.5 | 100 | 1 | 640 | 11.9 | common enemy | 26 |  |
| Valorium Greaves | a haunted chest (50) | Plane of Hate | 3.2 | 100 | 8 | 640 | 0.7 | common enemy | 4 |  |
| Velium Brawl Stick | a Paebala warrior (47) | Dragon Necropolis | 1.7 | 100 | 3 | 640 | 3.4 | common enemy | 27 |  |
| Velium War Mask | #Trooper Derheim (50) | Kael Drakkel | 1.1 | 100 | 1 | 520 | 13.6 | named | 41 |  |
| Vermiculated Bracelet | a haunted chest (50) | Plane of Hate | 25 | 100 | 8 | 640 | 0.1 | common enemy | 5 |  |
| Weighted Velium Battle Axe | a Chetari guard (48) | Dragon Necropolis | 0.1 | 100 | 30 | 640 | 10.8 | common enemy | 13 |  |
| White Bear Pelt Cloak | #Trooper Derheim (50) | Kael Drakkel | 1.1 | 100 | 1 | 520 | 13.6 | named | 4 | gear-white-bear-pelt-cloak |
| Withered Leather Boots | a citybound spirit (40) | The Hole | 0.3 | 100 | 11 | 1200 | 11.7 | common enemy | 21 |  |
| Withered Leather Gloves | a citybound spirit (40) | The Hole | 0.3 | 100 | 11 | 1200 | 11.7 | common enemy | 21 |  |
| Withered Leather Leggings | a citybound spirit (40) | The Hole | 0.3 | 100 | 11 | 1200 | 11.7 | common enemy | 21 |  |
| Withered Leather Sleeves | a citybound spirit (40) | The Hole | 0.5 | 100 | 11 | 1200 | 5.8 | common enemy | 21 |  |
| Wooden Shield | a zombie (8) | Kithicor Forest | 1.2 | 33 | 70 | 400 | 0.4 | common enemy | 31 |  |
| Woven Shadow Boots | an abhorrent (49) | Plane of Hate | 2.7 | 100 | 8 | 640 | 0.8 | common enemy | 4 |  |
| Woven Shadow Chestplate | an abhorrent (49) | Plane of Hate | 2.7 | 100 | 8 | 640 | 0.8 | common enemy | 4 |  |
| Woven Shadow Greaves | an abhorrent (49) | Plane of Hate | 2.7 | 100 | 8 | 640 | 0.8 | common enemy | 4 |  |
| Woven Shadow Vambraces | an abhorrent (49) | Plane of Hate | 2.7 | 100 | 8 | 640 | 0.8 | common enemy | 4 |  |
| Wurmfire Totem | an elder wyvern (48) | The Skyfire Mountains | 1.0 | 100 | 6 | 640 | 3.0 | common enemy | 72 |  |
| Yeti Fur-Lined Sleeves | a tundra yeti (32) | The Dreadlands | 0.5 | 100 | 13 | 640 | 2.5 | common enemy | 17 |  |

## Picks in data/gear-picks.json

The items above with named or rare droppers are listed with their zone and dropper in `data/gear-picks.json`. The gear pass adds them to the drops of the band rotations, and the gear acquisition model ([gear-acquisition.md](gear-acquisition.md)) decides which group hunts which dropper, and how, from what each copy adds to its taker against the hunting it takes.

- `keep` is the NPC's name without `#` and without a leading article, matched as a case-insensitive pattern (`enemyPattern` in `src/bot.js`). Checked against the snapshot's spawn tables, it matches only that NPC's variants in its zone, except the cyclops, whose pattern is anchored because The Fabled Ancient Cyclops shares the name.
- One dropper, the gnoll embalmer of the Golden Ear Stud, spawns only by day (`tools/drops.mjs`, the `when` column). Gear targets do not read spawn conditions yet, so its hunts can come at night.
- Items whose copies need more than 250 hours at one spawn point are left out:

| Item | Dropper (level) | Zone | Count | Hours per copy | Hours for all copies |
| --- | --- | --- | ---: | ---: | ---: |
| Mithril-Runed Tunic | a froglok crusader (42) | The Ruins of Old Guk | 46 | 5.7 | 262 |
| Glowing Torch | Tisella (12) | Lavastorm Mountains | 57 | 5.0 | 285 |
| Embroidered Black Sleeves | a ghoul ritualist (34) | The Ruins of Old Guk | 46 | 6.4 | 296 |
| Platinum Tiara | a froglok tactician (45) | The Ruins of Old Guk | 46 | 6.4 | 296 |
| Idol of the Thorned | Chief RokGus (38) | Frontier Mountains | 72 | 4.3 | 310 |
| Squallsurge Shawl | Undertow (49) | Kedge Keep | 20 | 23.3 | 467 |
| Velium War Mask | #Trooper Derheim (50) | Kael Drakkel | 41 | 13.6 | 557 |
| Chipped Bone Bracelet | The Great Oowomp (34) | Timorous Deep | 67 | 8.9 | 596 |
| Sentry Helmet | Sentry Kale (39) | Skyshrine | 43 | 15.8 | 680 |
| Scute Shield | Dunedigger (15) | Northern Desert of Ro | 47 | 17.8 | 836 |

## Limits

- Re-run the numbers when the snapshot or the survey changes.
