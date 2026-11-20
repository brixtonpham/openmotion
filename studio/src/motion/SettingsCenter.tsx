import { Button } from 'open-design-ui/button';
import * as tracking from './pageTracking';
import type { McpEntry } from './pageTracking';
import { useEffect, useState } from 'react';
import type { ModelKind } from '../../../shared/provider-directory';
import { RemixIcon } from '../icons/RemixIcons';
import { languages, useI18n, type Locale } from '../i18n/I18n';
import { Select } from '../components/ui/Select';
import { AppearanceSettings } from './AppearanceSettings';
import { ModelSettings, kindLabels } from './ModelSettings';
import { AccountSettings } from './AccountSettings';
import { PrivacySettings } from './PrivacySettings';
import { clickMethod, clickOption, trackStudioClick } from './editorTracking';
import { ModelSwitcher } from './ModelSwitcher';
import { useProviderDirectory } from './useProviderDirectory';
import { gatewayRequest } from './gatewayClient';
import { SettingsError, SettingsLoading } from './settingsPrimitives';
import { discord, feishu } from './CommunityLink';
import { GITHUB_REPOSITORY, repositorySupportLinks } from './githubRepository';

import type { SettingsSection } from './workspacePageRouting';
export type { SettingsSection } from './workspacePageRouting';

const cloudModelKinds: ModelKind[] = ['image', 'video', 'audio'];

const sections: { id: SettingsSection; label: string; icon: string; group: string }[] = [
  { id: 'account', label: 'Account', icon: 'user-3-line', group: 'Personal' },
  { id: 'subscription', label: 'Subscription & usage', icon: 'bank-card-line', group: 'Personal' },
  { id: 'providers', label: 'Model gateway', icon: 'brain-line', group: 'Models & connections' },
  { id: 'models', label: 'Default models', icon: 'box-3-line', group: 'Models & connections' },
  { id: 'mcp', label: 'MCP · Connect Agent', icon: 'plug-line', group: 'Models & connections' },
  { id: 'general', label: 'General', icon: 'equalizer-line', group: 'Preferences' },
  { id: 'appearance', label: 'Appearance', icon: 'palette-line', group: 'Preferences' },
  { id: 'privacy', label: 'Privacy & data', icon: 'shield-check-line', group: 'Preferences' },
  { id: 'help', label: 'Help', icon: 'question-line', group: 'Resources' },
  { id: 'about', label: 'About OpenMotion', icon: 'information-line', group: 'Resources' },
];

export function SettingsCenter({
  section,
  onSection: onSectionRaw,
  openConnections,
  providerId,
  onProviderChange,
  hasProject = false,
}: {
  hasProject?: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  openConnections: (entry: McpEntry) => void;
  providerId?: string | null;
  onProviderChange?: (id: string | null) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const filtered = sections.filter(item => t(item.label).toLowerCase().includes(search.toLowerCase()));
  // One view per section shown; the section is remounted for each route.
  useEffect(() => { tracking.reportSettingsPageView(section, hasProject); }, [section]);
  const onSection = (next: SettingsSection) => {
    if (next !== section) tracking.reportSettingsClick('settings_nav', 'section_select', { settings_section: next });
    onSectionRaw(next);
  };
  return (
    <div className="om-settings-center" onKeyDown={event => event.stopPropagation()}>
      <div className="om-settings-navigation-slot">
        <div className="om-settings-navigation-clip">
          <aside className="om-settings-navigation">
            <h1 className="om-navigation-title">{t('Settings')}</h1>
            <label className="om-field">
              <RemixIcon name="search-line" size={16} />
              <input
                type="search"
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('Search settings…')}
                aria-label={t('Search settings')}
              />
            </label>
            <div className="om-settings-mobile-navigation">
              <Select
                label={t('Settings')}
                value={section}
                onCommit={value => onSection(value as SettingsSection)}
                options={sections.map(item => ({ value: item.id, label: t(item.label), icon: <RemixIcon name={item.icon} size={16} /> }))}
              />
            </div>
            <nav aria-label={t('Settings')} className="om-settings-sections">
              {filtered.map((item, index) => (
                <div key={item.id}>
                  {filtered[index - 1]?.group !== item.group && <p className="om-eyebrow">{t(item.group)}</p>}
                  <Button
                    variant="plain"
                    className="om-nav-item"
                    aria-current={section === item.id ? 'page' : undefined}
                    onClick={event => {
                      if (item.id === 'privacy' && section !== 'privacy') trackStudioClick('settings', 'privacy_settings', undefined, clickMethod(event));
                      onSection(item.id);
                    }}
                  >
                    <RemixIcon name={item.icon} size={16} />
                    <span>{t(item.label)}</span>
                  </Button>
                </div>
              ))}
              {!filtered.length && <p className="om-muted">{t('No matching settings')}</p>}
            </nav>
          </aside>
        </div>
      </div>
      <main className="om-settings-main" aria-label={t(sections.find(item => item.id === section)?.label || 'Settings')}>
        {section === 'providers' ? (
          <ModelSettings key={section} openAccount={() => onSection('account')} providerId={providerId} onProviderChange={onProviderChange} />
        ) : section === 'account' || section === 'subscription' ? (
          <AccountSettings key={section} subscription={section === 'subscription'} openProviders={() => onSection('providers')} />
        ) : section === 'models' ? (
          <DefaultModels openProviders={() => onSection('providers')} />
        ) : section === 'appearance' ? (
          <AppearanceSettings />
        ) : section === 'privacy' ? (
          <div className="om-settings-page"><h1 className="om-title">{t('Privacy & data')}</h1><PrivacySettings embedded onClose={() => {}} /></div>
        ) : section === 'general' ? (
          <GeneralSettings openConnections={() => openConnections('settings_general')} />
        ) : (
          <ResourceSettings about={section === 'about'} openConnections={() => openConnections('settings_resources')} />
        )}
      </main>
    </div>
  );
}

function DefaultModels({ openProviders }: { openProviders: () => void }) {
  const { t } = useI18n();
  const directory = useProviderDirectory();
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t('Default models')}</h1>
      <p className="om-muted">{t('Choose the workspace default model for each media capability on the OpenDesign Model Gateway.')}</p>
      {directory.error ? <SettingsError retry={directory.refresh} /> : !directory.data ? <SettingsLoading /> : (
        <div className="om-card">
          {cloudModelKinds.map(kind => {
            const model = directory.data?.models.find(item => item.id === directory.data?.defaults[kind]);
            const provider = directory.data?.providers.find(item => item.id === model?.provider);
            return (
              <div className="om-preference-row" key={kind}>
                <div>
                  <h2 className="om-subtitle">{t(kindLabels[kind])}</h2>
                  <p className="om-muted">
                    {model
                      ? `${provider?.label ?? 'OpenDesign'} · ${model.label}${!provider?.available || !model.enabled ? ' · ' + t('Unavailable') : ''}`
                      : t(directory.data?.defaults[kind] ? 'Unavailable model' : 'No default selected')}
                  </p>
                </div>
                <ModelSwitcher capability={kind} label={t('Choose model')} openSettings={openProviders} />
              </div>
            );
          })}
        </div>
      )}
      <p className="om-muted">{t('External MCP Agents use these workspace defaults when a generation request omits an explicit model.')}</p>
    </div>
  );
}

function GeneralSettings({ openConnections }: { openConnections: () => void }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t('General')}</h1>
      <div className="om-card">
        <div className="om-preference-row">
          <div>
            <h2 className="om-subtitle">{t('Language')}</h2>
            <p className="om-muted">{t('Display language for the workspace')}</p>
          </div>
          <div className="om-preference-control">
            <Select
              label={t('Language')}
              value={locale}
              onCommit={value => {
                if (value !== locale) trackStudioClick('settings', 'language_change', undefined, undefined, clickOption(value));
                setLocale(value as Locale);
              }}
              options={languages.map(item => ({ value: item.locale, label: item.label }))}
            />
          </div>
        </div>
        <div className="om-preference-row">
          <div>
            <h2 className="om-subtitle">{t('Connect Agent')}</h2>
            <p className="om-muted">{t('Connect your preferred Agent over Streamable HTTP MCP.')}</p>
          </div>
          <Button variant="ghost" className="om-button h-auto" onClick={openConnections}>{t('Set up connection')}</Button>
        </div>
      </div>
      <section className="om-card om-card-stack">
        <h2 className="om-subtitle">{t('Keyboard shortcuts')}</h2>
        <div className="om-preference-row"><span>{t('Open settings')}</span><kbd>⌘ / Ctrl + ,</kbd></div>
        <div className="om-preference-row"><span>{t('Toggle project list')}</span><kbd>Alt + B</kbd></div>
        <div className="om-preference-row"><span>{t('Close menu or dialog')}</span><kbd>Esc</kbd></div>
      </section>
    </div>
  );
}

function ResourceSettings({ about, openConnections }: { about: boolean; openConnections: () => void }) {
  const { t, locale } = useI18n();
  const communityLinks = locale === 'zh-CN' ? [feishu, discord] : [discord, feishu];
  const [version, setVersion] = useState<string>();
  useEffect(() => {
    let active = true;
    void fetch('/api/health')
      .then(async res => {
        if (!res.ok) throw new Error('unavailable');
        return (await res.json()) as { version?: string };
      })
      .catch(() => gatewayRequest<{ version?: string }>('health'))
      .then(data => { if (active && data?.version) setVersion(data.version); })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  const links = [
    { label: 'Documentation', href: `${GITHUB_REPOSITORY}/tree/main/docs`, icon: 'file-text-line' },
    ...repositorySupportLinks,
    { label: 'View source code', href: GITHUB_REPOSITORY, icon: 'code-s-slash-line' },
  ];
  return (
    <div className="om-settings-page">
      <h1 className="om-title">{t(about ? 'About OpenMotion' : 'Help')}</h1>
      {about && (
        <section className="om-card om-about-identity">
          <h2 className="om-product-brand" aria-label="OpenMotion" />
          <p className="om-muted">{t('An editable cloud workspace for AI video and motion.')}</p>
          <span className="om-badge">{version ? `${t('Version')} ${version}` : t('Version unavailable')}</span>
        </section>
      )}
      <div className="om-card om-resource-links">
        {links.map((link, index) => (
          <a
            className="om-nav-item om-resource-link"
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => tracking.reportSettingsClick('help_resources', 'open_resource', { position: index + 1 })}
          >
            <span className="om-menu-label"><RemixIcon name={link.icon} size={16} />{t(link.label)}</span>
            <RemixIcon name="external-link-line" size={16} />
          </a>
        ))}
        <Button variant="plain" className="om-nav-item om-resource-link" onClick={openConnections}>
          <span className="om-menu-label"><RemixIcon name="plug-line" size={16} />{t('Connect Agent')}</span>
          <RemixIcon name="arrow-right-line" size={16} />
        </Button>
      </div>
      {!about && (
        <section className="om-card om-resource-links" aria-labelledby="om-community-heading">
          <h2 id="om-community-heading" className="om-subtitle">{t('Community')}</h2>
          {communityLinks.map((link, index) => (
            <a
              key={link.href}
              className="om-nav-item om-resource-link"
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => tracking.reportSettingsClick('help_resources', 'community', { position: index + 1 })}
            >
              <span>{link === feishu ? t('Feishu group') : link.platform}</span>
              <RemixIcon name="external-link-line" size={16} />
            </a>
          ))}
        </section>
      )}
      {about && (
        <section className="om-card om-card-stack">
          <h2 className="om-subtitle">{t('Acknowledgements')}</h2>
          <p className="om-muted">{t('Built with Hyperframes and the OpenMotion design system. Account identity and media generation are powered by OpenDesign.')}</p>
        </section>
      )}
    </div>
  );
}
