import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { seedDatabase } from './seed';

describe('seedDatabase', () => {
  const originalPassword = process.env.INITIAL_DEMO_PASSWORD;

  afterEach(() => {
    if (originalPassword === undefined) delete process.env.INITIAL_DEMO_PASSWORD;
    else process.env.INITIAL_DEMO_PASSWORD = originalPassword;
  });

  it('uses the configured initial password without overwriting existing password hashes', async () => {
    process.env.INITIAL_DEMO_PASSWORD = 'Custom@123456';
    const query = jest.fn().mockResolvedValue([]);

    await seedDatabase({ query } as unknown as DataSource, false);

    const userInserts = query.mock.calls.slice(0, 3);
    expect(userInserts).toHaveLength(3);
    for (const [sql, parameters] of userInserts) {
      expect(await bcrypt.compare('Custom@123456', parameters[2])).toBe(true);
      expect(sql).toContain('ON CONFLICT(username) DO UPDATE');
      expect(sql.split('DO UPDATE')[1]).not.toContain('password_hash');
    }
  });

  it('rejects an unsafe initial password', async () => {
    process.env.INITIAL_DEMO_PASSWORD = 'short';
    await expect(seedDatabase({ query: jest.fn() } as unknown as DataSource, false))
      .rejects.toThrow('INITIAL_DEMO_PASSWORD must contain at least 8 characters');
  });
});
