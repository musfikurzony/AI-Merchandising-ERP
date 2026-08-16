import React, { useEffect, useState } from "react";
import { getOrganizationSettings, updateOrganizationSettings, listSystemSettings, updateSystemSetting } from "../../lib/adminApi.js";
import { supabase } from "../../lib/supabaseClient.js";

export default function OrganizationSettings() {
  const [org, setOrg] = useState(null);
  const [settings, setSettings] = useState([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [logoFile, setLogoFile] = useState(null);

  async function refresh() {
    const [o, s] = await Promise.all([getOrganizationSettings(), listSystemSettings()]);
    setOrg(o); setSettings(s);
  }
  useEffect(() => { refresh(); }, []);

  async function handleSaveOrg() {
    setError(null);
    // Save the text fields FIRST, independently of any logo upload -- a
    // Storage failure (e.g. a missing bucket) must never block company
    // name/branch/website/address from saving, since those have nothing
    // to do with Storage. Previously both were inside one try block, so a
    // failed upload silently discarded the text-field save too.
    try {
      await updateOrganizationSettings({ company_name: org.company_name, branch: org.branch, website: org.website, address: org.address, logo_url: org.logo_url });
    } catch (e) {
      setError(`Could not save organization details: ${e.message}`);
      return;
    }

    if (logoFile) {
      try {
        // Admin uploads the logo directly to Storage -- never a file
        // embedded in the codebase, per the branding requirement.
        const path = `org-logo/${Date.now()}-${logoFile.name}`;
        const { error: upErr } = await supabase.storage.from("public-assets").upload(path, logoFile, { upsert: true });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from("public-assets").getPublicUrl(path);
        await updateOrganizationSettings({ company_name: org.company_name, branch: org.branch, website: org.website, address: org.address, logo_url: data.publicUrl });
      } catch (e) {
        setError(`Organization details saved, but the logo upload failed: ${e.message}`);
        await refresh();
        return;
      }
    }

    setSaved(true); setTimeout(() => setSaved(false), 2000);
    await refresh();
  }

  async function handleSettingChange(key, rawValue) {
    try {
      let value;
      try { value = JSON.parse(rawValue); } catch { value = rawValue; }
      await updateSystemSetting(key, value);
      await refresh();
    } catch (e) { setError(e.message); }
  }

  if (!org) return <p>Loading...</p>;

  return (
    <div>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <h3>Organization Branding</h3>
      <label className="field">Company Name
        <input value={org.company_name} onChange={e => setOrg({ ...org, company_name: e.target.value })} />
      </label>
      <label className="field">Branch
        <input value={org.branch} onChange={e => setOrg({ ...org, branch: e.target.value })} />
      </label>
      <label className="field">Website
        <input value={org.website || ""} onChange={e => setOrg({ ...org, website: e.target.value })} />
      </label>
      <label className="field">Address
        <input value={org.address || ""} onChange={e => setOrg({ ...org, address: e.target.value })} />
      </label>
      <label className="field">Logo
        {org.logo_url && <img src={org.logo_url} alt="Current logo" style={{ height: 40, display: "block", marginBottom: 6 }} />}
        <input type="file" accept="image/*" onChange={e => setLogoFile(e.target.files[0])} />
      </label>
      <button className="btn-primary" onClick={handleSaveOrg}>Save</button>
      {saved && <span style={{ marginLeft: 10, color: "#15803D" }}>Saved.</span>}

      <h3 style={{ marginTop: 32 }}>System Settings</h3>
      <table className="data-table">
        <thead><tr><th>Key</th><th>Value (JSON or plain text)</th></tr></thead>
        <tbody>
          {settings.map(s => (
            <tr key={s.key}>
              <td>{s.key}</td>
              <td>
                <input defaultValue={typeof s.value === "string" ? s.value : JSON.stringify(s.value)}
                  onBlur={e => handleSettingChange(s.key, e.target.value)} style={{ width: "100%" }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 12, color: "#6B7280" }}>Changes save on blur (click out of the field). Includes factory_portal_retention_months, late_documents_grace_days, security_policy, and others reserved for future modules.</p>
    </div>
  );
}
