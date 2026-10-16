/**
 * Film registers.
 *
 * Left to itself the writers' room produces competent nowhere-fiction: a
 * generic library, a generic railway, a villain called The Binder. The stories
 * were fine and none of them felt like anything. A register fixes that by
 * handing the room a genre to work inside — the ravine western, the dockside
 * revenge drama, the night heist — with the cast archetypes, the shape of the
 * villain and the shape of the twist that genre actually uses.
 *
 * These are **genres and archetypes**, drawn from the grammar of popular Hindi
 * cinema, not characters from particular films. The room writes its own people
 * with their own names: an original scarred dacoit chief above an original
 * village, not a character someone else owns. That is deliberate — the genre is
 * what carries the feeling, and borrowed names would put someone else's
 * property in a product while adding nothing a good archetype does not.
 *
 * The chapter still decides everything that matters. A register is the skin:
 * the concepts, the mechanics and what the player has to understand come from
 * the notes, and the register only decides who is standing there and why it is
 * raining. Which register a chapter gets is seeded by its hash, so the same
 * notes always open on the same film.
 */

export interface FilmRegister {
  id: string;
  /** What the room is told it is writing. */
  name: string;
  /** The world in one line. */
  world: string;
  /** Roles to cast from. Names are the room's own invention. */
  cast: string;
  /** What a villain looks like in this genre. */
  villain: string;
  /** The shape the turn takes — not the turn itself. */
  twist: string;
  /** Direction for `artStyle`. */
  look: string;
  /** The kinds of place this genre gives you to set an act in. */
  places: string;
}

export const REGISTERS: FilmRegister[] = [
  {
    id: 'ravine-western',
    name: 'The ravine western',
    world:
      'Sun-bleached ravines above a village that has been paying its harvest as protection for nine years. The nearest police post is a day away and knows it.',
    cast: 'A scarred bandit chief who laughs before he does anything. A retired police officer with one arm and a private reason. Two small-time crooks hired to do what the law cannot. A widow who rings the village bell.',
    villain:
      'The chief himself, or the man in town who has been taking a cut of the protection for keeping the road reports vague.',
    twist:
      'The protection ledger and the police ledger are the same handwriting.',
    look: 'Ochre dust and bleached khaki, long shadows at four in the afternoon, one red scarf, heat haze over stone.',
    places:
      'A ravine mouth, a grain store, a water tower, a railway halt, a village square with a bell.',
  },
  {
    id: 'dockside-ledger',
    name: 'The dockside revenge drama',
    world:
      'Monsoon docks where the cargo that is written down and the cargo that moves have never matched. Two brothers: one wears a badge, one has a number tattooed on his arm.',
    cast: 'The brother who took the badge. The brother who took the money. A mother who will have to choose in the last act. A union man who knows every crane by sound. A syndicate accountant who never raises his voice.',
    villain:
      'The accountant, or the man the badge reports to — never the brother, who is a tragedy rather than a villain.',
    twist:
      "The honest brother's case stands entirely on the crooked brother's evidence.",
    look: 'Wet concrete and sodium lamp orange, rain across floodlights, oil-rainbow puddles, stacked containers in the dark.',
    places:
      'A crane gantry, a weighbridge, a customs shed, a chawl staircase, a temple under a flyover.',
  },
  {
    id: 'night-heist',
    name: 'The night heist caper',
    world:
      'A thief who posts the date of the next theft a week in advance, and a police officer who has been one rooftop behind for two years.',
    cast: 'The thief, who is charming and never explains. The officer, who is better than everyone says and worse than they need. A fence who deals only in daylight. A commissioner with a budget that depends on the case staying open.',
    villain:
      'The thief, until the last act makes you wonder who has been profiting from the chase.',
    twist: 'The posted note was never a warning. It was an alibi.',
    look: 'Neon on wet glass, chrome and black, headlamp streaks, a city skyline at three in the morning.',
    places:
      'A rooftop water tank, a vault corridor, a bike workshop, a hotel service lift, a bridge span.',
  },
  {
    id: 'lost-and-found',
    name: 'The lost-and-found family saga',
    world:
      'Three children separated at a fairground in one afternoon, raised in three different houses, converging thirty years later on the same hospital corridor.',
    cast: 'A tailor who sings. A constable who follows rules nobody else does. A doctor who left and came back. The man who drove them apart and now needs one of them alive.',
    villain:
      'The man who separated them, respectable now, with a hospital wing named after him.',
    twist: 'The chart on the wall matches a name nobody in the room expects.',
    look: 'Fairground bulbs and hospital green, faded family photographs, marigold orange, dust in a projector beam.',
    places:
      'A fairground wheel, a hospital blood bank, a tailor’s shop, a police records room, a lost-property office.',
  },
  {
    id: 'coal-belt',
    name: 'The coal-belt crime thriller',
    world:
      'A transport cartel that owns the weighbridge, the road and the man who signs the slips. Every lorry leaves heavier than it arrives and the books say otherwise.',
    cast: 'A junior engineer who signs what he is handed. A transporter who is everyone’s uncle. A surveyor who measures honestly once. A sarpanch holding two positions at once.',
    villain: 'The transporter, who has never once been seen near a lorry.',
    twist:
      'Nothing was stolen. It was mis-measured on purpose, and the method is on the slip in plain sight.',
    look: 'Coal black and diesel blue, dust on every surface, tube-light white, hills stripped to terraces.',
    places:
      'A weighbridge hut, a loading ramp, a survey office, a dhaba at a junction, a seam face.',
  },
  {
    id: 'the-match',
    name: 'The underdog match',
    world:
      'A team nobody picked, a coach nobody wanted, and a single fixture that decides whether a whole district keeps what it has.',
    cast: 'A coach who was dropped from the national side and will not say why. A captain who is the only one who believes it. An official who set the terms and expects them to lose. A groundskeeper who knows the pitch better than anyone playing on it.',
    villain:
      'The official who wrote the terms, who has never broken a single rule.',
    twist:
      'The rule written to beat them is the rule that wins it, read carefully.',
    look: 'Dust and white kit, stadium floodlights through evening haze, tricolour bunting, sweat and red earth.',
    places:
      'A practice net, a groundsman’s shed, a pavilion balcony, a village field, a selection room.',
  },
  {
    id: 'district-court',
    name: 'The district court drama',
    world:
      'A small-town courtroom with a ceiling fan that drowns out the witness, a junior lawyer with one case, and a senior counsel who has not lost in eleven years.',
    cast: 'The junior, who is funnier than he is prepared. The senior counsel, courteous and lethal. A judge who has heard everything. A forensic officer whose report is correct and is being used wrongly.',
    villain: 'The senior counsel, or whoever briefed the report into the file.',
    twist:
      'The report is right. The question it was asked was the wrong question.',
    look: 'Dusty legal red, fan shadows on brown files, afternoon light through louvred windows, black coats.',
    places:
      'A courtroom, a records basement, a forensics bench, a chamber corridor, a tea stall opposite the gate.',
  },
  {
    id: 'haunted-haveli',
    name: 'The small-town horror comedy',
    world:
      'A town that locks its doors after dark because of something everyone has agreed to believe, and a handful of people who cannot afford the curfew.',
    cast: 'A tailor who is the bravest coward available. A priest with a generator and strong opinions. A woman who appears only at night and knows too much. A contractor who has done very well out of the curfew.',
    villain: 'Whoever profits from the town being indoors by seven.',
    twist: 'The ghost is real, and is right about entirely the wrong thing.',
    look: 'Lantern yellow against blue night, peeling haveli plaster, long verandas, fog at ankle height.',
    places:
      'A haveli courtyard, a tailor’s shop, a well, a shuttered market lane, a temple step.',
  },
  {
    id: 'long-train',
    name: 'The long-distance train romance',
    world:
      'Three days across the country on a train that is already late, a woman travelling away from her own wedding, and a stranger who keeps missing his stop on purpose.',
    cast: 'The runaway, who has a plan and no map. The stranger, who has a map and no plan. A travelling ticket examiner who sees everything. A family fixer two coaches behind.',
    villain: 'The fixer, polite throughout, sent to bring her back.',
    twist: 'The connection they missed was arranged to be missed.',
    look: 'Dusk through a moving window, steel blue and berth brown, platform tube-lights, tea in paper cups.',
    places:
      'A sleeper coach, a junction platform, a guard’s van, a station tea stall, a signal cabin.',
  },
];

/**
 * Two different registers for a chapter, stable across runs.
 *
 * The two drafts get different films so the judge has an actual choice to make
 * — two drafts of the same genre differ by set dressing, and the judge ends up
 * picking on prose rather than on which world plays better.
 */
export function registersFor(hash: string): [FilmRegister, FilmRegister] {
  const seed = seedOf(hash);
  const first = seed % REGISTERS.length;
  // Co-prime stride, so the second is never the first and the pairing varies.
  const second = (first + 1 + (seed % (REGISTERS.length - 1))) % REGISTERS.length;
  return [REGISTERS[first]!, REGISTERS[second]!];
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
