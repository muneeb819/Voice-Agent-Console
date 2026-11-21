/** Typed access to the shared Med Benefits Medicare (Jessica) template. */
export interface MedicareTemplate {
  AGENT: { name: string; greeting: string; selfIntro: string; keyterms: string; prompt: string };
  CAMPAIGN: { name: string; disclosure: string; dispos: string; complianceRules: string };
  VERSION: string;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api: MedicareTemplate = require('../public/medicare-template.js');
export const MEDICARE_TEMPLATE = api;
