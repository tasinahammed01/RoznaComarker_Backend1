// src/types/worksheet.ts
// Single source of truth for all worksheet data structures.
// Every worksheet — regardless of how it was created — produces this exact JSON shape.

// ─── Activity / Question Types ────────────────────────────────────────────────

export type ActivityType =
  | "ordering_sequencing" // Arrange items in correct order
  | "classification" // Categorize items into groups
  | "multiple_choice" // Answer multiple choice questions (was "mcq")
  | "fill_in_blanks" // Complete sentences with missing words (was "fill_blank")
  | "matching_pairs" // Match related items together (was "matching")
  | "true_false" // Determine if statements are true or false
  | "short_answer"; // Write brief responses to questions

/** Backward-compatibility alias. New code should use ActivityType. */
export type QuestionType = ActivityType;

export const ACTIVITY_TYPE_META: Record<
  ActivityType,
  { label: string; description: string; icon: string }
> = {
  ordering_sequencing: {
    label: "Ordering/Sequencing",
    description: "Arrange items in correct order",
    icon: "🔢",
  },
  classification: {
    label: "Classification",
    description: "Categorize items into groups",
    icon: "🗂️",
  },
  multiple_choice: {
    label: "Multiple Choice",
    description: "Answer multiple choice questions",
    icon: "⭕",
  },
  fill_in_blanks: {
    label: "Fill in the Blanks",
    description: "Complete sentences with missing words",
    icon: "✏️",
  },
  matching_pairs: {
    label: "Matching Pairs",
    description: "Match related items together",
    icon: "🔗",
  },
  true_false: {
    label: "True/False",
    description: "Determine if statements are true or false",
    icon: "✅",
  },
  short_answer: {
    label: "Short Answer",
    description: "Write brief responses to questions",
    icon: "📝",
  },
};

export const MAX_ACTIVITY_TYPES = 6;

// ─── Layout ───────────────────────────────────────────────────────────────────

export type LayoutType =
  | "single_column"
  | "two_column"
  | "diagram_with_boxes"
  | "grid"
  | "table";

// ─── Color Scheme ─────────────────────────────────────────────────────────────

export interface WorksheetColorScheme {
  primary: string;
  primaryLight: string;
  background: string;
  text: string;
  accent: string;
  headerBg: string;
  headerText: string;
  boxBorder: string;
  labelBg: string;
  labelText: string;
}

// ─── Section Types ────────────────────────────────────────────────────────────

export interface WorksheetSection {
  id: string;
  type:
    | "header"
    | "instructions"
    | "question_block"
    | "diagram_labels"
    | "word_bank"
    | "footer"
    | "divider";
  content:
    | HeaderContent
    | InstructionsContent
    | QuestionBlockContent
    | DiagramLabelsContent
    | WordBankContent
    | FooterContent;
}

export interface HeaderContent {
  showNameField: boolean;
  showDateField: boolean;
  showClassField: boolean;
  title: string;
  subtitle?: string;
  logoUrl?: string;
  decorativeImageUrl?: string;
}

export interface InstructionsContent {
  text: string;
  bold?: boolean;
  alignment?: "left" | "center" | "justify";
}

export interface Question {
  id: string;
  number: number;
  type: ActivityType;
  questionText: string;
  writeLines?: number;
  // Multiple choice
  options?: string[];
  // Matching pairs
  matchPairs?: { left: string; right: string }[];
  // Ordering/sequencing
  items?: string[];
  correctOrder?: string[];
  // Classification
  categories?: string[];
  classificationItems?: string[];
  classificationAnswers?: Record<string, string[]>;
  // Common
  answer?: string;
  points?: number;
  imageUrl?: string;
}

export interface QuestionBlockContent {
  sectionTitle?: string;
  showSectionTitle: boolean;
  questions: Question[];
  layout: LayoutType;
  columns?: number;
}

export interface DiagramLabel {
  id: string;
  labelName: string;
  position:
    | "top"
    | "top-right"
    | "right"
    | "bottom-right"
    | "bottom"
    | "bottom-left"
    | "left"
    | "top-left";
  writeLines: number;
  boxWidth?: string;
}

export interface DiagramLabelsContent {
  centralImage: {
    query: string;
    url: string;
    alt: string;
    position: "left" | "center" | "right";
    width?: string;
  };
  labels: DiagramLabel[];
  instructions?: string;
}

export interface WordBankContent {
  title: string;
  words: string[];
}

export interface FooterContent {
  leftText: string;
  rightText?: string;
  showPageNumber?: boolean;
}

// ─── Root Document ────────────────────────────────────────────────────────────

export interface WorksheetDocument {
  id: string;
  version: "1.0";
  createdAt: string;
  createdBy: string;
  source: "text_prompt" | "file_upload";
  sourceFileUrl?: string;

  meta: {
    title: string;
    description?: string; // Teacher's optional description (max 500 chars)
    subject: string;
    topic: string;
    gradeCategory: string; // e.g. "primary"
    gradeLevel: string; // e.g. "grade_3"
    cefrLevel?: string; // e.g. "B1"
    estimatedMinutes: number;
    difficulty: "easy" | "medium" | "hard";
    theme: string; // Color/visual theme, e.g. "default", "green"
    activityTypes: ActivityType[]; // Selected activity types for this worksheet
    tags: string[];
    language: string;
  };

  design: {
    colorScheme: WorksheetColorScheme;
    layout: LayoutType;
    fontFamily: string;
    fontSize: "small" | "medium" | "large";
    pageSize: "A4" | "Letter";
    margins: "narrow" | "normal" | "wide";
    hasDecorativeImage: boolean;
  };

  sections: WorksheetSection[];

  answerKey: {
    questionId: string;
    answer: string;
  }[];
}
