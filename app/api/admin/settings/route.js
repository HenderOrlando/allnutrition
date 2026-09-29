import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try { await authorize(request); return json(await (await db()).settings()); } catch (error) { return errorResponse(error); } }
export async function PUT(request) { try { await authorize(request, { write: true }); const data = await jsonBody(request); return json(await (await db()).saveSettings(data, data?.version)); } catch (error) { return errorResponse(error); } }
