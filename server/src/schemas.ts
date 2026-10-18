/**
 * Gemini responseSchemas for every structured-output call. Enums wherever the
 * model has a fixed set to choose from — a constrained decode is cheaper to
 * repair than a free-text one.
 *
 * These mirror the design-time types in shared/types.ts. If you change one,
 * change both.
 */
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';

const str = { type: Type.STRING } as const;
const num = { type: Type.NUMBER } as const;
const strList = { type: Type.ARRAY, items: { type: Type.STRING } } as const;

/** Record<string, string>: Gemini has no map type, so pairs it is. */
const EXPR_MAP: Schema = {
  type: Type.ARRAY,
  description: 'Name/expression pairs.',
  items: {
    type: Type.OBJECT,
    properties: { name: str, expr: str },
    required: ['name', 'expr'],
  },
};

const NUMBER_MAP: Schema = {
  type: Type.ARRAY,
  description: 'Name/value pairs.',
  items: {
    type: Type.OBJECT,
    properties: { name: str, value: num },
    required: ['name', 'value'],
  },
};

export const CURRICULUM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: str,
    subject: {
      type: Type.STRING,
      description: 'Broad field, e.g. physics, machine-learning, chemistry.',
    },
    concepts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'kebab-case, unique.' },
          name: str,
          keyRule: {
            type: Type.STRING,
            description: 'The one sentence a player must end up believing.',
          },
          requires: { ...strList, description: 'ids of concepts that must come first.' },
          difficulty: { type: Type.INTEGER, description: '1 (easiest) to 5 (hardest).' },
          misconceptions: strList,
          kind: {
            type: Type.STRING,
            enum: ['formula', 'sequence', 'evidence', 'ai-system', 'qualitative'],
          },
          quote: {
            type: Type.STRING,
            description: 'VERBATIM sentence copied from the chapter. Do not paraphrase.',
          },
          page: { type: Type.INTEGER },
        },
        required: [
          'id',
          'name',
          'keyRule',
          'requires',
          'difficulty',
          'misconceptions',
          'kind',
          'quote',
          'page',
        ],
      },
    },
  },
  required: ['title', 'subject', 'concepts'],
};

export const OUTLINE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    title: str,
    logline: str,
    artStyle: str,
    villain: str,
    twist: str,
    cast: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'kebab-case, unique.' },
          name: str,
          look: str,
          persona: str,
          misconception: {
            type: Type.STRING,
            description: 'The misconception this character personifies. Empty string if none.',
          },
        },
        required: ['id', 'name', 'look', 'persona'],
      },
    },
    acts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'act1, act2, act3.' },
          conceptId: str,
          title: str,
          sceneName: str,
          oneLine: str,
        },
        required: ['id', 'conceptId', 'title', 'sceneName', 'oneLine'],
      },
    },
  },
  required: ['title', 'logline', 'artStyle', 'villain', 'twist', 'cast', 'acts'],
};

export const SIM_SPEC_SCHEMA: Schema = {
  type: Type.OBJECT,
  description: 'A tiny explicit-Euler simulation. Expressions may use params, constants and state.',
  properties: {
    constants: NUMBER_MAP,
    state: { ...EXPR_MAP, description: 'Initial state as expressions over params/constants.' },
    step: { ...EXPR_MAP, description: 'Per-step updates, e.g. v = "v + a * dt".' },
    outputs: { ...EXPR_MAP, description: 'Computed once the run ends.' },
    win: { type: Type.STRING, description: 'Boolean expression. True = solved.' },
    dt: num,
    maxTime: num,
    until: { type: Type.STRING, description: 'Optional early-stop boolean, e.g. "v <= 0".' },
  },
  required: ['constants', 'state', 'step', 'outputs', 'win', 'dt', 'maxTime'],
};

const MECHANIC_SCHEMA: Schema = {
  type: Type.OBJECT,
  description:
    'Exactly one of formula / sequence / evidence / aiSystem / qualitative, matching the concept kind.',
  properties: {
    type: {
      type: Type.STRING,
      enum: ['formula', 'sequence', 'evidence', 'ai-system', 'qualitative'],
    },
    formula: {
      type: Type.OBJECT,
      properties: {
        spec: SIM_SPEC_SCHEMA,
        params: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: str,
              min: num,
              max: num,
              default: { ...num, description: 'Starting dial position. Must NOT win.' },
              solution: { ...num, description: 'A value that does win.' },
              when: {
                type: Type.STRING,
                enum: ['before', 'during'],
                description:
                  'during = a control held and corrected while the run plays; before = part of the situation, set once.',
              },
            },
            required: ['name', 'min', 'max', 'default', 'solution'],
          },
        },
      },
      required: ['spec', 'params'],
    },
    aiSystem: {
      type: Type.OBJECT,
      properties: {
        ragAct: {
          type: Type.STRING,
          enum: ['chunking', 'embeddings', 'topk', 'grounding', 'injection'],
        },
        question: str,
        goldFact: { type: Type.STRING, description: 'The fact a correct answer must contain.' },
      },
      required: ['ragAct', 'question', 'goldFact'],
    },
    sequence: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: 'The instruction on the board, e.g. "Order the stages of water treatment".',
        },
        items: {
          type: Type.ARRAY,
          description: '4 to 8 cards. Each a step, stage or event from the chapter.',
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: 'kebab-case, unique.' },
              label: { type: Type.STRING, description: 'What the card says. Under 8 words.' },
              detail: {
                type: Type.STRING,
                description: 'One line of detail. Must not give away the order.',
              },
            },
            required: ['id', 'label'],
          },
        },
        rules: {
          type: Type.ARRAY,
          description: 'Ordering facts from the chapter: "before" must come before "after".',
          items: {
            type: Type.OBJECT,
            properties: {
              before: { type: Type.STRING, description: 'Card id.' },
              after: { type: Type.STRING, description: 'Card id.' },
              why: {
                type: Type.STRING,
                description:
                  'Why it has to be this way round, from the chapter. Shown when broken.',
              },
              evidence: {
                ...strList,
                description:
                  '1 to 3 passages copied VERBATIM from the chapter that state this ordering. Checked character for character.',
              },
            },
            required: ['before', 'after', 'why', 'evidence'],
          },
        },
        solution: {
          ...strList,
          description: 'Every card id once, in an order that breaks no rule.',
        },
      },
      required: ['prompt', 'items', 'rules', 'solution'],
    },
    evidence: {
      type: Type.OBJECT,
      properties: {
        prompt: { type: Type.STRING, description: 'The instruction on the board.' },
        claims: {
          type: Type.ARRAY,
          description: '2 to 5 claims the chapter makes, each one sentence.',
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: 'kebab-case, unique.' },
              text: str,
            },
            required: ['id', 'text'],
          },
        },
        documents: {
          type: Type.ARRAY,
          description: '3 to 7 documents, at least one a decoy that backs no claim.',
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING, description: 'kebab-case, unique.' },
              title: {
                type: Type.STRING,
                description: 'What the document is called in the world.',
              },
              excerpt: {
                type: Type.STRING,
                description:
                  'One passage copied VERBATIM from the chapter. Checked character for character.',
              },
              shows: {
                type: Type.STRING,
                description:
                  'What this passage establishes, one sentence, without naming which claim it backs.',
              },
            },
            required: ['id', 'title', 'excerpt', 'shows'],
          },
        },
        links: {
          type: Type.ARRAY,
          description: 'Every claim/document pair where the document backs the claim.',
          items: {
            type: Type.OBJECT,
            properties: {
              claim: { type: Type.STRING, description: 'Claim id.' },
              document: { type: Type.STRING, description: 'Document id.' },
              why: { type: Type.STRING, description: 'How the passage backs the claim.' },
            },
            required: ['claim', 'document', 'why'],
          },
        },
      },
      required: ['prompt', 'claims', 'documents', 'links'],
    },
    qualitative: {
      type: Type.OBJECT,
      properties: { mustShow: strList, misconceptions: strList },
      required: ['mustShow', 'misconceptions'],
    },
  },
  required: ['type'],
};

export const ACT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    id: str,
    conceptId: str,
    title: str,
    goal: { type: Type.STRING, description: 'What the player must do, in world terms.' },
    verbs: {
      type: Type.ARRAY,
      items: {
        type: Type.STRING,
        enum: [
          'drive',
          'aim_launch',
          'plant_marker',
          'interrogate',
          'deduction',
          'intercept',
          'tune',
          'arrange',
        ],
      },
    },
    prediction: {
      type: Type.OBJECT,
      properties: {
        question: str,
        options: strList,
        correctIndex: { type: Type.INTEGER },
      },
      required: ['question', 'options', 'correctIndex'],
    },
    explainAfter: str,
    analogy: {
      type: Type.OBJECT,
      properties: {
        text: str,
        breaksWhere: {
          type: Type.STRING,
          description: 'Where the analogy stops being true. Required.',
        },
      },
      required: ['text', 'breaksWhere'],
    },
    dialogue: {
      type: Type.ARRAY,
      description: 'At most 6 lines, each at most 25 words.',
      items: {
        type: Type.OBJECT,
        properties: { speaker: str, line: str },
        required: ['speaker', 'line'],
      },
    },
    scene: {
      type: Type.OBJECT,
      properties: {
        name: str,
        description: str,
        objects: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { id: str, label: str, look: str },
            required: ['id', 'label', 'look'],
          },
        },
        exitSide: { type: Type.STRING, enum: ['north', 'south', 'east', 'west'] },
      },
      required: ['name', 'description', 'objects', 'exitSide'],
    },
    mechanic: MECHANIC_SCHEMA,
  },
  required: [
    'id',
    'conceptId',
    'title',
    'goal',
    'verbs',
    'prediction',
    'explainAfter',
    'analogy',
    'dialogue',
    'scene',
    'mechanic',
  ],
};

/** What the draft judge returns. Server-side only — never reaches the client. */
/** One answer from the guide. Mirrors NpcTurn, minus the offline flag the server sets. */
export const GUIDE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    reply: {
      ...str,
      description: 'What the guide says. In character, at most three short sentences.',
    },
    mood: { type: Type.STRING, enum: ['neutral', 'pleased', 'worried'] },
    understanding: {
      ...num,
      description: 'How well the player seems to grasp the key rule, 0 to 1.',
    },
    misconception: {
      ...str,
      description: 'The wrong idea the question reveals, in one line. Empty if none.',
    },
    unlock: {
      type: Type.BOOLEAN,
      description: 'True only if the player has just stated the key rule correctly.',
    },
  },
  required: ['reply', 'mood', 'understanding', 'misconception', 'unlock'],
};

export interface DraftScore {
  draft: 'A' | 'B';
  conceptAsMechanic: number;
  storyHook: number;
  clarity: number;
  guessabilityRisk: 'low' | 'medium' | 'high';
  total: number;
  notes: string;
}

export interface JudgeVerdict {
  winner: 'A' | 'B';
  scores: DraftScore[];
}

export const JUDGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    winner: { type: Type.STRING, enum: ['A', 'B'] },
    scores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          draft: { type: Type.STRING, enum: ['A', 'B'] },
          conceptAsMechanic: { type: Type.INTEGER, description: '0-5.' },
          storyHook: { type: Type.INTEGER, description: '0-5.' },
          clarity: { type: Type.INTEGER, description: '0-5.' },
          guessabilityRisk: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
          total: { type: Type.INTEGER, description: 'Sum of the three 0-5 scores, out of 15.' },
          notes: str,
        },
        required: [
          'draft',
          'conceptAsMechanic',
          'storyHook',
          'clarity',
          'guessabilityRisk',
          'total',
          'notes',
        ],
      },
    },
  },
  required: ['winner', 'scores'],
};

/** What the evidence judge returns: one verdict per statement it was shown. */
export const GROUNDING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ref: { type: Type.STRING, description: 'The statement id exactly as given.' },
          verdict: { type: Type.STRING, enum: ['supported', 'contradicted', 'insufficient'] },
          reason: {
            type: Type.STRING,
            description: 'One sentence, quoting the words that decide it.',
          },
        },
        required: ['ref', 'verdict', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

/** What the teaching director returns after a failed attempt. */
export const ADAPT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    misconceptionIndex: {
      type: Type.INTEGER,
      description: 'Number of the listed wrong idea the facts point to, or -1.',
    },
    because: { type: Type.STRING, description: 'One sentence linking a fact to that idea.' },
    technique: {
      type: Type.STRING,
      enum: ['contrast', 'worked_example', 'simpler_wording', 'debug_mistake'],
    },
    voiceLine: {
      type: Type.STRING,
      description: 'The owner character voicing the wrong idea, under 25 words. Empty if no owner.',
    },
    message: { type: Type.STRING, description: "The guide's teaching move, under 60 words." },
  },
  required: ['misconceptionIndex', 'because', 'technique', 'voiceLine', 'message'],
};

/** The Oracle's answer, from the scrolls in its satchel. */
export const RAG_ANSWER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: { answer: { type: Type.STRING, description: 'One or two sentences.' } },
  required: ['answer'],
};

/** A reranker's scores: how directly each passage answers the question. */
export const RAG_RERANK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    scores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { id: str, score: { type: Type.NUMBER, description: '0 to 10.' } },
        required: ['id', 'score'],
      },
    },
  },
  required: ['scores'],
};

/** Claims in an answer that the record it should rest on does not state. */
export const RAG_JUDGE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    unsupported: {
      ...strList,
      description: 'Each claim about the question that the record does not state. Empty if none.',
    },
  },
  required: ['unsupported'],
};
