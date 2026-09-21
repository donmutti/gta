# One delivery

A design for giving the game something to ask of the player. Today it can only punish.

## 1. The problem

The game has a city that behaves correctly and nothing for anybody to do in it. That is not an impression; it is countable. These are every message the game is capable of saying to a player, all five of them:

| what the game says | when |
|---|---|
| `WANTED — police responding` | you were seen committing a crime |
| `You knocked someone over!` | you hit a pedestrian |
| `Ran a red light` | you crossed on red |
| `They have you pinned — drive!` | the police have you boxed in |
| `BUSTED` | the police caught you |

**Every one is a reaction to something the player did wrong.** A player can be punished and cannot be asked. There is no task anywhere in the code: no mission, no objective, no destination, nothing with a completion.

> The city has been built for three days and this row has never been worked on. Everything shipped so far serves either "a stranger can drive it" or "nothing betrays that the world was generated", and both are well served. This is the first piece of work aimed at the game being a game.

## 2. What must be true when this is done

- A stranger who has never seen the game completes one delivery, start to finish, **without being told how**. That is the whole test and it is the only one that counts.
- The game says something to the player that is not a punishment.
- A delivery can be **failed** as well as completed, and failing says so and ends cleanly.
- Nothing about the existing city, traffic, crowd or police changes.

## 3. What this is not

- **Not a mission system.** One delivery, built end to end, and no framework for a second kind. A system with no mission in it would be another correct thing with no destination, which is exactly the failure this document exists to answer.
- **Not an economy.** No money, no score to accumulate, no upgrades. A delivery completes or fails and that is the end of it.
- **Not a story.** No characters, no dialogue, no named client.
- **Not a timer on the city.** The clock, the weather and the police keep working the way they do.

## 4. The delivery

### 4.1. The loop, in four states

`idle` → `offered` → `carrying` → `done` or `failed`, and back to `idle`.

There is one delivery available at a time. When none is active the game offers one; taking it is driving into the pickup, and there is no button to press and nothing to accept.

### 4.2. Where it happens: streets, because the game already names them

The destination is **a named street**, and the reason is that the game already tells the player which street they are on. Every road the player drives down puts its name on screen, so "deliver to Rue Willy Goergen" is expressed in a vocabulary the player has already been handed without being taught it.

1,135 of the city's 1,667 roads carry a real name from the map data. The pickup and the destination are both points on named roads, chosen far enough apart to be a drive and close enough to be findable.

> Cafés, squares and monuments were considered first and rejected for this piece: the data has their positions but not their names, so a delivery to one could only be described as a dot. A dot is findable and it is not a *place*, and the difference is the whole reason for building the city out of a real map.

### 4.3. How the player knows where to go, without being told

Three signals, none of them instructions:

- **The street name**, which the player is already reading, and which the objective line names.
- **A marker on the minimap**, which already draws the player, the police and traffic, and which a player is already watching.
- **A beacon in the world**, tall enough to be seen over buildings from a street away, standing on the point itself.

The beacon is what makes it possible without instructions. A name tells a player where to go when they know the city; a beacon tells them where to go when they do not.

> **It draws through the city rather than being occluded by it, and that was found by looking rather than reasoned about.** The first version was depth-tested like everything else, which meant standing seventy metres from a drop with a building in between showed nothing at all — a beacon visible only once you no longer need it. It now renders over the geometry, like a waypoint, which is the only version that does the job the paragraph above claims for it.

### 4.4. What can go wrong

A delivery **fails** on a timer, and the timer is generous enough that failing means having stopped rather than having been slow. Being busted also fails it, because the player is no longer driving.

> Failure has to exist or completion means nothing, and it has to be rare or the first thing the game asks of anybody is something they lose. Generous is the deliberate setting.

## 5. What the game says

The first non-punitive strings in the game, and every one is either an offer, a confirmation, or an outcome:

| state | what the player sees |
|---|---|
| `offered` | `Pickup on Boulevard Royal` |
| `carrying` | `Deliver to Rue Willy Goergen` with the time remaining |
| `done` | `Delivered` and the time it took |
| `failed` | `Too late` |

> **This said the alert channel would carry them, and building it proved that wrong.** An alert is transient by construction: it fades, and it must, because "Ran a red light" is about a moment. An objective is the opposite — a destination and a countdown have to be readable at any instant, including the one after a chase. Sharing the channel meant either the objective flickering or the alerts sticking. The objective has its own line under the clock, and the outcomes appear there too.

## 6. What changes in the code

| file | change |
|---|---|
| `src/game/delivery.js` | new. The four states, the pair of points, the timer, and the strings. Pure simulation: no Three.js |
| `src/game/minimap.js` | draws the active marker |
| `src/render/scene.js` | the beacon, one mesh, shown and hidden |
| `src/main.js` | steps the delivery each frame and passes its line to the HUD |
| `src/game/hud.js` | shows the objective line and the remaining time |

**Nothing in the city, the crowd, the traffic or the police is touched**, which is both a scope statement and the thing that keeps this reversible.

## 7. Workflows

### 7.1. Complete a delivery

**7.1.1. Take a Delivery**

- Game picks a pickup point and a destination on two named roads.
- Game shows a beacon at the pickup and a marker on the minimap.
- Game says where the pickup is, by street name.
- User drives into the pickup.
- Game says where the delivery goes, by street name, and starts the timer.

**7.1.2. Deliver It**

- Game moves the beacon and the marker to the destination.
- User drives to the destination.
- Game says it is delivered, with the time taken.
- Game returns to offering after a pause.

**7.1.3. Fail a Delivery**

- Timer runs out, or the player is busted.
- Game says so, removes the beacon and the marker, and returns to offering.

## 8. Open questions

1. **Is the beacon enough for somebody who has never played it?** The whole design rests on it and it has not been tested on anybody. This document is not DONE until one person who has not seen the game completes a delivery without being told how — which is item 5's own reaching condition and cannot be answered by the author.
2. **How long is generous?** A number will be chosen by measuring the drive and doubling it, and that is a guess with a measurement attached rather than a decision.
3. **Should a delivery survive being busted?** Failing on arrest is the simple answer and may be the wrong one: it punishes the player twice for one mistake. Built as failing, and the message says so rather than leaving the job silently gone.

> One implementation note that cost a bug: `police.state.busted` is **consumed** at the top of the frame by the block that respawns the player, so anything downstream reading that flag sees false every time. The delivery did exactly that and could never fail on an arrest — it completed perfectly and the failure path was dead. Found by testing the path the happy path cannot reach.
