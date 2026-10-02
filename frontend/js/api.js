const TetscrowApi = (() => {
  function authHeaders() {
    const jwt = localStorage.getItem("tetscrow_jwt");
    return jwt ? { Authorization: `Bearer ${jwt}` } : {};
  }

  async function request(path, options = {}) {
    let res;
    try {
      res = await fetch(`${window.TETSCROW_CONFIG.API_BASE}${path}`, {
        ...options,
        headers: { "Content-Type": "application/json", ...authHeaders(), ...(options.headers || {}) },
      });
    } catch (e) {
      throw new Error(`Can't reach the Tetscrow server at ${window.TETSCROW_CONFIG.API_BASE}. Is the backend running?`);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || body);
      } catch { detail = await res.text().catch(() => ""); }
      if (res.status === 401) localStorage.removeItem("tetscrow_jwt"); // stale session: sign in again next time
      const err = new Error(detail || `API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) });

  return {
    stats: () => request("/stats"),
    // profile
    me: () => request("/users/me"),
    updateMe: (body) => request("/users/me", { method: "PUT", body: JSON.stringify(body) }),
    myStats: () => request("/users/me/stats"),
    profile: (address) => request(`/users/${address}`),
    // jobs & milestones
    createJob: (body) => post("/jobs", body),
    myJobs: (sort) => request(`/jobs/mine?sort=${encodeURIComponent(sort || "newest")}`),
    getJob: (id) => request(`/jobs/${id}`),
    syncJob: (id) => post(`/jobs/${id}/sync`),
    addMilestone: (jobId, body) => post(`/jobs/${jobId}/milestones`, body),
    accept: (escrowId, sig) => post(`/milestones/${escrowId}/accept`, sig),
    requestExtension: (escrowId, newDeadline, sig) => post(`/milestones/${escrowId}/extension`, { ...sig, new_deadline: newDeadline }),
    approveExtension: (escrowId, sig) => post(`/milestones/${escrowId}/extension/approve`, sig),
    updateDeadline: (escrowId, newDeadline, sig) => post(`/milestones/${escrowId}/deadline`, { ...sig, new_deadline: newDeadline }),
    // chat
    messages: (jobId) => request(`/jobs/${jobId}/messages`),
    sendMessage: (jobId, body) => post(`/jobs/${jobId}/messages`, body),
    downloadFile: (jobId, messageId) => request(`/jobs/${jobId}/messages/${messageId}/file`),
    // disputes
    myDisputes: () => request("/disputes/mine"),
    getDispute: (id) => request(`/disputes/${id}`),
    openDispute: (body) => post("/disputes", body),
    challenge: (id, sig) => post(`/disputes/${id}/challenge`, sig),
    modifyDispute: (id, claimAmount, sig) => post(`/disputes/${id}/modify`, { ...sig, claim_amount: claimAmount }),
    settleDispute: (id, sig) => post(`/disputes/${id}/settle`, sig),
    inviteSupport: (id, sig) => post(`/disputes/${id}/arbitrage`, sig),
    resolveDispute: (id, body) => post(`/disputes/${id}/resolve`, body),
  };
})();
