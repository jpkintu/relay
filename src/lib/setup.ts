// How far Admin → Get started has got (getSetupProgress). Kept apart from the
// page itself so the owner's menu can show it without loading the page.

export type SetupProgress = {
  steps: { details: boolean; logo: boolean; menu: boolean; riders: boolean; cashiers: boolean };
  dishes: number;
  starterDishes: number;
  riders: number;
  cashiers: number;
  complete: boolean;
  finished: boolean;
};

export const STEP_ORDER = ['details', 'menu', 'riders', 'cashiers', 'logo'] as const;
export const STEP_COUNT = STEP_ORDER.length;
export const stepsDone = (progress: SetupProgress) =>
  STEP_ORDER.filter((step) => progress.steps[step]).length;
