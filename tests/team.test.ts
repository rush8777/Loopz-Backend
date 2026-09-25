import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { memberships, organizationInvitations, organizations } from "../src/db/schema.js";
import { createTestApp, signup } from "./helpers.js";

describe("team invitations and membership management", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeEach(async () => {
    ctx = await createTestApp();
  });
  afterEach(() => ctx.cleanup());

  async function addExistingMember(
    owner: Awaited<ReturnType<typeof signup>>,
    member: Awaited<ReturnType<typeof signup>>,
    role: "ADMIN" | "MEMBER" | "VIEWER",
  ) {
    return ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/members`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: member.user.email, role },
    });
  }

  async function invite(
    actor: Awaited<ReturnType<typeof signup>>,
    orgId: string,
    email: string,
    role: "ADMIN" | "MEMBER" | "VIEWER" = "MEMBER",
  ) {
    return ctx.app.inject({
      method: "POST",
      url: `/orgs/${orgId}/invitations`,
      headers: { authorization: `Bearer ${actor.accessToken}` },
      payload: { email, role },
    });
  }

  function tokenFrom(response: { json(): { inviteUrl: string } }) {
    return new URL(response.json().inviteUrl).pathname.split("/").pop()!;
  }

  it("allows OWNER and ADMIN invitations, but rejects MEMBER, VIEWER, and OWNER invitation roles", async () => {
    const owner = await signup(ctx.app, { email: "team-owner@example.com" });
    const admin = await signup(ctx.app, { email: "team-admin@example.com" });
    const member = await signup(ctx.app, { email: "team-member@example.com" });
    const viewer = await signup(ctx.app, { email: "team-viewer@example.com" });
    await addExistingMember(owner, admin, "ADMIN");
    await addExistingMember(owner, member, "MEMBER");
    await addExistingMember(owner, viewer, "VIEWER");

    expect((await invite(owner, owner.org.id, "owner-invite@example.com")).statusCode).toBe(201);
    expect((await invite(admin, owner.org.id, "admin-invite@example.com", "VIEWER")).statusCode).toBe(201);
    expect((await invite(member, owner.org.id, "member-invite@example.com")).statusCode).toBe(403);
    expect((await invite(viewer, owner.org.id, "viewer-invite@example.com")).statusCode).toBe(403);
    const ownerRole = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
      payload: { email: "no-owner@example.com", role: "OWNER" },
    });
    expect(ownerRole.statusCode).toBe(400);
  });

  it("normalizes email and rejects existing members and duplicate pending invitations", async () => {
    const owner = await signup(ctx.app, { email: "dupe-owner@example.com" });
    const existing = await signup(ctx.app, { email: "existing@example.com" });
    await addExistingMember(owner, existing, "MEMBER");
    expect((await invite(owner, owner.org.id, "EXISTING@example.com")).json()).toMatchObject({ error: "already_a_member" });

    const first = await invite(owner, owner.org.id, "  New.Person@Example.com ");
    expect(first.statusCode).toBe(201);
    expect(first.json().invitation.email).toBe("new.person@example.com");
    const duplicate = await invite(owner, owner.org.id, "new.person@example.com");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: "invitation_already_pending" });
  });

  it("never returns token hashes from invitation list responses", async () => {
    const owner = await signup(ctx.app, { email: "list-owner@example.com" });
    await invite(owner, owner.org.id, "pending@example.com");
    const result = await ctx.app.inject({
      method: "GET",
      url: `/orgs/${owner.org.id}/invitations`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().invitations[0]).not.toHaveProperty("tokenHash");
    expect(result.json().invitations[0].status).toBe("pending");
  });

  it("rejects expired and revoked invitation tokens", async () => {
    const owner = await signup(ctx.app, { email: "invalid-owner@example.com" });
    const expiredInvite = await invite(owner, owner.org.id, "expired@example.com");
    const expiredToken = tokenFrom(expiredInvite);
    await ctx.db
      .update(organizationInvitations)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(organizationInvitations.id, expiredInvite.json().invitation.id));
    expect((await ctx.app.inject({ method: "GET", url: `/auth/invitations/${expiredToken}` })).statusCode).toBe(404);

    const revokedInvite = await invite(owner, owner.org.id, "revoked@example.com");
    const revokedToken = tokenFrom(revokedInvite);
    await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/invitations/${revokedInvite.json().invitation.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect((await ctx.app.inject({ method: "GET", url: `/auth/invitations/${revokedToken}` })).statusCode).toBe(404);
  });

  it("rotates a pending invitation and invalidates its previous token", async () => {
    const owner = await signup(ctx.app, { email: "rotate-owner@example.com" });
    const created = await invite(owner, owner.org.id, "rotate@example.com");
    const oldToken = tokenFrom(created);
    const rotated = await ctx.app.inject({
      method: "POST",
      url: `/orgs/${owner.org.id}/invitations/${created.json().invitation.id}/rotate`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(rotated.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: `/auth/invitations/${oldToken}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "GET", url: `/auth/invitations/${tokenFrom(rotated)}` })).statusCode).toBe(200);
  });

  it("lets an existing matching user join while preserving their original workspace", async () => {
    const owner = await signup(ctx.app, { email: "accept-owner@example.com" });
    const existing = await signup(ctx.app, { email: "accept-user@example.com", orgName: "Original workspace" });
    const created = await invite(owner, owner.org.id, existing.user.email, "ADMIN");
    const accepted = await ctx.app.inject({
      method: "POST",
      url: `/auth/invitations/${tokenFrom(created)}/accept`,
      headers: { authorization: `Bearer ${existing.accessToken}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().membership).toMatchObject({ orgId: owner.org.id, role: "ADMIN" });
    const orgs = await ctx.app.inject({
      method: "GET",
      url: "/orgs",
      headers: { authorization: `Bearer ${existing.accessToken}` },
    });
    expect(orgs.json().organizations.map((org: { orgId: string }) => org.orgId)).toEqual(
      expect.arrayContaining([existing.org.id, owner.org.id]),
    );
    expect((await ctx.app.inject({
      method: "POST",
      url: `/auth/invitations/${tokenFrom(created)}/accept`,
      headers: { authorization: `Bearer ${existing.accessToken}` },
    })).statusCode).toBe(404);
  });

  it("rejects invitation acceptance by the wrong authenticated email", async () => {
    const owner = await signup(ctx.app, { email: "wrong-owner@example.com" });
    const wrong = await signup(ctx.app, { email: "wrong-account@example.com" });
    const created = await invite(owner, owner.org.id, "right-account@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/auth/invitations/${tokenFrom(created)}/accept`,
      headers: { authorization: `Bearer ${wrong.accessToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "invitation_email_mismatch", invitationEmail: "right-account@example.com" });
  });

  it("creates a new invited account without creating another organization", async () => {
    const owner = await signup(ctx.app, { email: "signup-owner@example.com" });
    const before = await ctx.db.select().from(organizations);
    const created = await invite(owner, owner.org.id, "brand-new@example.com", "VIEWER");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/auth/invitations/${tokenFrom(created)}/signup`,
      payload: { name: "Brand New", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ email: "brand-new@example.com", name: "Brand New" });
    expect(response.json().membership).toMatchObject({ orgId: owner.org.id, role: "VIEWER" });
    expect(await ctx.db.select().from(organizations)).toHaveLength(before.length);
    const rows = await ctx.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, response.json().user.id), eq(memberships.orgId, owner.org.id)));
    expect(rows).toHaveLength(1);
  });

  it("requires existing invited users to sign in instead of invitation signup", async () => {
    const owner = await signup(ctx.app, { email: "exists-owner@example.com" });
    await signup(ctx.app, { email: "already-has-account@example.com" });
    const created = await invite(owner, owner.org.id, "already-has-account@example.com");
    const response = await ctx.app.inject({
      method: "POST",
      url: `/auth/invitations/${tokenFrom(created)}/signup`,
      payload: { name: "Existing", password: "correct-horse-battery-staple" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "account_exists_sign_in" });
  });

  it("enforces unique membership pairs at the database level", async () => {
    const owner = await signup(ctx.app, { email: "unique-owner@example.com" });
    expect(() => ctx.db.insert(memberships).values({ userId: owner.user.id, orgId: owner.org.id, role: "MEMBER" }).run()).toThrow();
  });

  it("allows ADMIN role changes and removals while locking OWNER and cross-tenant rows", async () => {
    const owner = await signup(ctx.app, { email: "manage-owner@example.com" });
    const admin = await signup(ctx.app, { email: "manage-admin@example.com" });
    const member = await signup(ctx.app, { email: "manage-member@example.com" });
    const stranger = await signup(ctx.app, { email: "manage-stranger@example.com" });
    await addExistingMember(owner, admin, "ADMIN");
    await addExistingMember(owner, member, "MEMBER");

    const changed = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/members/${member.user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { role: "VIEWER" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ userId: member.user.id, role: "VIEWER" });

    for (const method of ["PATCH", "DELETE"] as const) {
      const ownerMutation = await ctx.app.inject({
        method,
        url: `/orgs/${owner.org.id}/members/${owner.user.id}`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
        ...(method === "PATCH" ? { payload: { role: "MEMBER" } } : {}),
      });
      expect(ownerMutation.statusCode).toBe(409);
    }

    const crossTenant = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/members/${stranger.user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { role: "VIEWER" },
    });
    expect(crossTenant.statusCode).toBe(404);

    const removed = await ctx.app.inject({
      method: "DELETE",
      url: `/orgs/${owner.org.id}/members/${member.user.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it("does not allow MEMBER to change another member's role", async () => {
    const owner = await signup(ctx.app, { email: "rbac-owner@example.com" });
    const member = await signup(ctx.app, { email: "rbac-member@example.com" });
    const target = await signup(ctx.app, { email: "rbac-target@example.com" });
    await addExistingMember(owner, member, "MEMBER");
    await addExistingMember(owner, target, "VIEWER");
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/orgs/${owner.org.id}/members/${target.user.id}`,
      headers: { authorization: `Bearer ${member.accessToken}` },
      payload: { role: "ADMIN" },
    });
    expect(response.statusCode).toBe(403);
  });
});
