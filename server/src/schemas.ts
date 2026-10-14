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
          kind: { type: Type.STRING, enum: ['formula', 'ai-system', 'qualitative'] },
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
  description: 'Exactly one of formula / aiSystem / qualitative, matching the concept kind.',
  properties: {
    type: { type: Type.STRING, enum: ['formula', 'ai-system', 'qualitative'] },
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
