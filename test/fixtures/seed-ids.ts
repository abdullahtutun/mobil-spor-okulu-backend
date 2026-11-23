/**
 * `seed.sql`'deki sabit kimlikler. Uydurma veri; ayrıntı seed.sql başında.
 * Hesapların hepsinin şifresi `SEED_PASSWORD`.
 */
export const SEED_PASSWORD = 'Test1234!';

export const SCHOOL_A = 'a0000000-0000-4000-8000-000000000001'; // dev_adim
export const SCHOOL_B = 'b0000000-0000-4000-8000-000000000001'; // public

export const BRANCH_A1 = 'a0000000-0000-4000-8000-0000000000b1';
export const BRANCH_A2 = 'a0000000-0000-4000-8000-0000000000b2';

export const USERS = {
  a: {
    generalManager: 'a0000000-0000-4000-8000-0000000000a9',
    branchManager: 'a0000000-0000-4000-8000-0000000000a2',
    assistant: 'a0000000-0000-4000-8000-0000000000a3',
    coach: 'a0000000-0000-4000-8000-0000000000a4',
    coach2: 'a0000000-0000-4000-8000-0000000000a7',
    accountant: 'a0000000-0000-4000-8000-0000000000a5',
    dietician: 'a0000000-0000-4000-8000-0000000000a6',
    parent: 'a0000000-0000-4000-8000-0000000000a8',
    passiveParent: 'a0000000-0000-4000-8000-0000000000b8',
  },
  b: {
    generalManager: 'b0000000-0000-4000-8000-0000000000c9',
    coach: 'b0000000-0000-4000-8000-0000000000c4',
    parent: 'b0000000-0000-4000-8000-0000000000c8',
  },
} as const;

export const ATHLETES = {
  deniz: 'a0000000-0000-4000-8000-000000000101', // A1, veli: a.parent
  ege: 'a0000000-0000-4000-8000-000000000102', // A1, veli: a.passiveParent
  ada: 'a0000000-0000-4000-8000-000000000103', // A2, velisiz
  mina: 'b0000000-0000-4000-8000-000000000201', // okul B, veli: b.parent
} as const;
