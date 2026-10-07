export {};

type SessionItem = {
  id: string;
  createdAt: number;
  messageCount: number;
  preview: string;
  systemPrompt?: string;
  summary?: string;
  hasPdf: boolean;
};

const sessionsList = document.getElementById("sessionsList") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const refreshBtn = document.getElementById("refreshBtn") as HTMLButtonElement;

function formatDate(ts: number | string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function renderPdfButton(session: SessionItem, container: HTMLElement) {
  container.innerHTML = "";

  if (session.hasPdf) {
    const a = document.createElement("a");
    a.href = `/api/sessions/${session.id}/pdf`;
    a.className = "btn-primary btn-download";
    a.download = `${session.id}.pdf`;
    a.textContent = "📥 Download PDF";
    container.appendChild(a);
  } else {
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "📄 Create PDF";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "⏳ Generating...";
      try {
        const res = await fetch(`/api/sessions/${session.id}/create-pdf`, {
          method: "POST",
        });
        if (!res.ok) throw new Error("Failed to create PDF");
        session.hasPdf = true;
        renderPdfButton(session, container);
      } catch (err) {
        alert("Error creating PDF: " + (err instanceof Error ? err.message : String(err)));
        btn.disabled = false;
        btn.textContent = "📄 Create PDF";
      }
    });
    container.appendChild(btn);
  }
}

async function loadSessions() {
  loadingEl.style.display = "block";
  errorEl.style.display = "none";
  emptyEl.style.display = "none";
  sessionsList.innerHTML = "";

  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load sessions`);
    const data: { sessions: SessionItem[] } = await res.json();
    loadingEl.style.display = "none";

    if (!data.sessions || data.sessions.length === 0) {
      emptyEl.style.display = "block";
      return;
    }

    for (const session of data.sessions) {
      const card = document.createElement("article");
      card.className = "session-card";

      const header = document.createElement("div");
      header.className = "session-card-header";

      const titleGroup = document.createElement("div");
      titleGroup.className = "session-title-group";

      const link = document.createElement("a");
      link.href = `/session-detail.html?id=${encodeURIComponent(session.id)}`;
      link.className = "session-link";
      link.textContent = session.id;

      const dateSpan = document.createElement("span");
      dateSpan.className = "session-date";
      dateSpan.textContent = formatDate(session.createdAt);

      titleGroup.appendChild(link);
      titleGroup.appendChild(dateSpan);

      const badgeGroup = document.createElement("div");
      badgeGroup.className = "meta-row";
      const countBadge = document.createElement("span");
      countBadge.className = "badge";
      countBadge.textContent = `💬 ${session.messageCount} messages`;
      badgeGroup.appendChild(countBadge);

      header.appendChild(titleGroup);
      header.appendChild(badgeGroup);
      card.appendChild(header);

      if (session.summary) {
        const summaryBox = document.createElement("div");
        summaryBox.className = "session-summary-snippet";
        summaryBox.innerHTML = `<strong>Summary:</strong> ${session.summary}`;
        card.appendChild(summaryBox);
      } else if (session.preview) {
        const preview = document.createElement("p");
        preview.className = "preview-quote";
        preview.textContent = `"${session.preview}"`;
        card.appendChild(preview);
      }

      const actions = document.createElement("div");
      actions.className = "card-actions";

      const viewLink = document.createElement("a");
      viewLink.href = `/session-detail.html?id=${encodeURIComponent(session.id)}`;
      viewLink.className = "view-link";
      viewLink.textContent = "View Conversation →";

      const pdfBtnContainer = document.createElement("div");
      renderPdfButton(session, pdfBtnContainer);

      actions.appendChild(viewLink);
      actions.appendChild(pdfBtnContainer);
      card.appendChild(actions);

      sessionsList.appendChild(card);
    }
  } catch (err) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Error loading sessions: " + (err instanceof Error ? err.message : String(err));
  }
}

refreshBtn.addEventListener("click", () => {
  loadSessions();
});

loadSessions();
