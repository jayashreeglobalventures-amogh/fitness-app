import { describe, expect, it } from 'vitest';
import { GROUPS, TOPICS, topicText } from '../../web/src/help.js';

describe('Help content', () => {
  it('every topic has a unique link id, a known group, an audience and some text', () => {
    const ids = TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TOPICS) {
      expect(/^[a-z0-9-]+$/.test(t.id)).toBe(true);
      expect(GROUPS).toContain(t.group);
      expect(t.audience.length).toBeGreaterThan(0);
      expect(topicText(t).length).toBeGreaterThan(80);
    }
  });

  it('searches find what people ask about', () => {
    const find = (w: string) => TOPICS.filter((t) => topicText(t).toLowerCase().includes(w)).map((t) => t.id);
    expect(find('correct')).toContain('correct');
    expect(find('rest day')).toContain('rest-days');
    expect(find('carry')).toContain('fine-pool');
    expect(find('whatsapp')).toEqual(expect.arrayContaining(['correct', 'team-tab']));
  });
});
