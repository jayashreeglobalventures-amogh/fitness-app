// The worked example shown in every challenge's Demo tab (web/src/pages/Demo.tsx): five people, first 14 days.
// R = rest day, E = approved exemption. Chosen so that, with Calamari-like rules, every rule happens at least once.
export const DEMO_PEOPLE = ['Asha', 'Ben', 'Chitra', 'Dev', 'Esha'] as const;
export const DEMO_SCRIPT: Record<(typeof DEMO_PEOPLE)[number], string> = {
  Asha: 'SSSSSSSSSSSSSS',   // every day: personal streak milestones
  Ben: 'SSSRSSSSSSSSSS',    // a rest day: no points, streak paused, team day still OK
  Chitra: 'SSSSSSSSSESSSS', // an approved exemption on day 10
  Dev: 'SSSSSSSSSSSMSS',    // misses day 12, does the weekend bonus
  Esha: 'SSSSSSSSMMSSSS',   // misses days 9-10, then a comeback
};
