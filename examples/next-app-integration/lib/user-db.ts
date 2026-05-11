/**
 * Stub in-memory user DB. Replace with your real backend (Postgres, Mongo, etc.).
 * Exported functions are what the Relay webhook handler calls.
 */
import { randomUUID, randomBytes } from 'node:crypto';

interface User {
  id: string;
  email: string;
  name: string | null;
  source: string;
  createdAt: Date;
  keys: Map<string, { label: string; key: string; createdAt: Date }>;
}

const USERS = new Map<string, User>();

export async function createUser(input: {
  email: string;
  name: string | null;
  source: string;
}): Promise<User> {
  const id = randomUUID();
  const user: User = {
    id,
    email: input.email,
    name: input.name,
    source: input.source,
    createdAt: new Date(),
    keys: new Map(),
  };
  USERS.set(id, user);
  return user;
}

export async function issueApiKey(userId: string, label: string): Promise<string> {
  const user = USERS.get(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const key = `sk-demo-${randomBytes(16).toString('base64url')}`;
  const keyId = randomUUID();
  user.keys.set(keyId, { label, key, createdAt: new Date() });
  return key;
}

export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
  const user = USERS.get(userId);
  if (!user) return;
  user.keys.delete(keyId);
}

export async function deleteUser(userId: string): Promise<void> {
  USERS.delete(userId);
}
