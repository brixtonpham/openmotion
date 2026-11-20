import { McpClientAvatar } from './McpClientAvatar';
import { Button } from 'open-design-ui/button';
import type { CreativeStudio, TechniqueStudio } from '../../../shared/studio-catalog';
import { useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Modality } from '../../../shared/gateway';
import { Popover } from '../components/ui/Popover';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { creativeStudios, studioIconTone, mediaLabels, sceneDestination, studioScenes, supportsScene, type StudioDestination } from './creativeStudios';
import { mcpClients, type McpClient } from './mcpClients';
import { useMediaCatalog } from './useMediaCatalog';
import { Tooltip } from '../components/ui/Tooltip';
import { ModelAvatar } from './settingsPrimitives';
import lunarStill from './scene-art/lunar-shot-still.webp';
import speakerStudio from './scene-art/speaker-studio.webp';
import { sceneExamples } from './sceneShowcase';
import { destinationTarget, reportCreativeClick, type CreativePage, type CreativeTarget } from './exploreTracking';

export type CreativeNavigationProps = {
  onChooseStudio: (studio: CreativeStudio, kind?: Modality) => void;
  specialty: TechniqueStudio | null;
  destination: StudioDestination | null;
  motionActive: boolean;
  designActive?: boolean;
  onNavigate: (destination: StudioDestination | null) => void;
  currentPage: 'explore' | 'mcp' | null;
  onOpenPage: (page: 'explore' | 'mcp', client?: McpClient) => void;
  /** The page this navigation is shown on, so its clicks segment by where the user was. */
  trackingPage: CreativePage;
};

function MediaChoices({ kind, destination, onNavigate, catalog }: Pick<CreativeNavigationProps, 'destination' | 'onNavigate'> & Pick<ReturnType<typeof useMediaCatalog>, 'catalog'> & { kind: Modality }) {
  const { t } = useI18n();
  const scenes = studioScenes.filter(scene => scene.modality === kind);
  const pinned = catalog?.models.find(model => model.id === destination?.model);
  const models = catalog?.models.filter(model => model.modality === kind && scenes.some(scene => supportsScene(model, scene))) ?? [];
  const distinctModels = [...new Map(models.map(model => [model.label, model])).values()];
  return <>
    <div className="om-media-menu-grid">
      {scenes.map(scene => {
        const example = sceneExamples[scene.id][0];
        return <Button variant="plain" key={scene.id} className="om-scene-tile" aria-current={destination?.scene.id === scene.id ? 'page' : undefined}
          onClick={() => onNavigate(sceneDestination(scene, destination, pinned && supportsScene(pinned, scene) ? pinned.id : null))}>
          {scene.id === 'text-to-image' ? (
            <span className="om-scene-tile-art om-media-demo om-image-demo" aria-hidden="true">
              <span className="om-media-demo-frame">
                <img src={example.poster} alt="" />
                <span className="om-image-demo-input">
                  <span className="om-image-demo-lines"><i /><i /><i /></span>
                  <span className="om-image-demo-send">↑</span>
                </span>
              </span>
            </span>
          ) : scene.id === 'image-edit' ? (
            <span className="om-scene-tile-art om-media-demo om-edit-demo" aria-hidden="true">
              <span className="om-media-demo-frame">
                <img src={speakerStudio} alt="" />
                <img className="om-edit-demo-result" src={example.poster} alt="" />
              </span>
            </span>
          ) : scene.id === 'shot-image' ? (
            <span className="om-scene-tile-art om-media-demo om-shot-demo" aria-hidden="true">
              <span className="om-media-demo-frame">
                <span className="om-shot-composition">
                  <img src={lunarStill} alt="" />
                  <span className="om-shot-viewfinder" />
                </span>
              </span>
            </span>
          ) : (
            <span className="om-scene-tile-art"><img src={example.poster} alt="" style={{ objectPosition: example.posterPosition }} /></span>
          )}
          <strong>{t(scene.label)}</strong>
        </Button>;
      })}
    </div>
    {distinctModels.length > 0 && <div className="om-media-menu-models" role="group" aria-label={t('Models')}>
      <span className="om-media-menu-model-label">{t('Models')}</span>
      {distinctModels.map(model => <Tooltip key={model.id} label={model.label}>
        <span tabIndex={0} role="img" aria-label={model.label}>
          <ModelAvatar name={model.label} modelId={model.modelId} provider={{ id: model.provider, custom: model.source === 'custom' }} />
        </span>
      </Tooltip>)}
    </div>}
  </>;
}

export function CreativeNavigation({ specialty, onChooseStudio, destination, motionActive, designActive, onNavigate, currentPage, onOpenPage, overflowActions, trackingPage }: CreativeNavigationProps & { overflowActions?: (close: () => void) => ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<Modality | 'mcp' | null>(null);
  const [popupHost, setPopupHost] = useState<HTMLElement>();
  const navId = useId();
  const rail = useRef<HTMLElement>(null);
  const catalog = useMediaCatalog(open !== null && open !== 'mcp');
  const trackPage = trackingPage;
  const track = (element: Parameters<typeof reportCreativeClick>[2], target: CreativeTarget) => reportCreativeClick(trackPage, 'creative_nav', element, target);

  const [visibleCount, setVisibleCount] = useState(Infinity);
  const [moreOpen, setMoreOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = rail.current!;
    const row = strip.current!;
    const trigger = more.current!;
    setPopupHost(viewport.closest<HTMLElement>('dialog, [data-feedback-modal]') ?? undefined);
    const items = Array.from(row.querySelectorAll<HTMLElement>(':scope > [data-nav-slot]'));
    const update = () => {
      const available = viewport.clientWidth;
      if (!available) return;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const widths = items.map(item => item.getBoundingClientRect().width);
      const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
      let count = widths.length;
      if (total > available) {
        const compact = getComputedStyle(row).getPropertyValue('--compact-nav').trim() === '1';
        const limit = compact ? 4 : widths.length;
        let used = trigger.getBoundingClientRect().width;
        count = 0;
        while (count < limit && used + gap + widths[count] <= available) {
          used += gap + widths[count++];
        }
      }
      setVisibleCount(count);
    };
    update();
    const observer = new ResizeObserver(update);
    [viewport, trigger, ...items].forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const choose = (action: () => void) => {
    const navigation = rail.current;
    if (open && navigation && !navigation.contains(document.activeElement)) {
      // A disappearing menu item must not reclaim focus from an input on the destination page.
      navigation.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')?.focus({ preventScroll: true });
    }
    setOpen(null);
    setMoreOpen(false);
    action();
  };
  const menuDestinations = [
    ...creativeStudios.filter(studio => studio.surface === 'media').map(studio => {
      const kind = studio.primaryModality;
      const label = t(mediaLabels[kind]);
      return { id: kind, label, current: destination?.scene.modality === kind ? 'location' as const : undefined,
        menuLabel: label + ' · ' + t('Scenes'), onActivate: () => onChooseStudio(studio, kind) };
    }),
    { id: 'mcp' as const, label: 'MCP', current: currentPage === 'mcp' ? 'page' as const : undefined,
      menuLabel: 'Generate with Open Design MCP', onActivate: () => onOpenPage('mcp') },
  ];
  const splitStart = 1;
  const studioStart = splitStart + menuDestinations.length;
  const count = studioStart + creativeStudios.length;
  const hasMore = visibleCount < count || Boolean(overflowActions);

  useLayoutEffect(() => {
    setOpen(null);
    if (!hasMore) setMoreOpen(false);
  }, [visibleCount, hasMore]);

  function splitItem(index: number, inPanel: boolean) {
    const { id, label, current, menuLabel, onActivate } = menuDestinations[index - splitStart];
    const expanded = open === id && (index >= visibleCount) === inPanel;
    const where = { navTarget: id, inOverflow: inPanel };
    return <div className="om-nav-row om-creative-split" data-active={Boolean(current)}>
          <Popover container={popupHost} modal={false} openOnHover={!inPanel} open={expanded}
            onOpenChange={value => setOpen(previous => value ? id : previous === id ? null : previous)}
            aria-label={menuLabel} align="start" className={id === 'mcp' ? 'om-selection-panel om-creative-client-menu' : `om-selection-panel om-creative-menu om-creative-menu-${id}`}
            primaryAction={<Button variant="plain" className="om-nav-item om-nav-row-link" aria-current={current} onClick={() => { track(id === 'mcp' ? 'nav_mcp' : 'nav_media', where); choose(onActivate); }}>{label}</Button>}
            trigger={<Button variant="plain" className="om-nav-item om-nav-row-action" aria-label={menuLabel} aria-expanded={expanded}><RemixIcon name="arrow-down-s-line" size={12} /></Button>}>
            {id === 'mcp' ? <>
              <h2 lang="en">{menuLabel}</h2>
              <div className="om-mcp-client-grid">
                {mcpClients.map(client => <Button variant="plain" className="om-nav-item" key={client.id} onClick={() => { track('select_client', { ...where, client: client.id }); choose(() => onOpenPage('mcp', client.id)); }}>
                  <McpClientAvatar client={client} /><span>{t(client.name)}</span>
                </Button>)}
              </div>
            </> : expanded && <MediaChoices catalog={catalog.catalog} kind={id} destination={destination} onNavigate={next => { track('select_scene', { ...where, ...destinationTarget(next) }); choose(() => onNavigate(next)); }} />}
          </Popover>
        </div>;
  }

  function item(index: number, inPanel = false) {
    if (index === 0) return <Button variant="plain" className="om-nav-item om-explore-link" aria-label={t('Explore')} title={t('Explore')}
      aria-current={currentPage === 'explore' ? 'page' : undefined} onClick={() => { track('nav_explore', { navTarget: 'explore', inOverflow: inPanel }); choose(() => onOpenPage('explore')); }}>
      <RemixIcon name="global-line" size={17} /><span>{t('Explore')}</span>
    </Button>;
    if (index < studioStart) return splitItem(index, inPanel);
    const studio = creativeStudios[index - studioStart];
    const isCurrent = studio.surface === 'editor' ? motionActive
      : (studio.id === 'design' && Boolean(designActive)) || (studio.id === destination?.studio.id && !destination?.landing) || studio.id === specialty?.id;
    const badge = 'navBadge' in studio ? studio.navBadge : undefined;
    const badgeId = badge ? navId + '-' + studio.id + (inPanel ? '-more' : '') : undefined;
    return <Button variant="plain" className="om-nav-item" data-coming-soon={badge === 'Coming soon' || undefined} aria-current={isCurrent ? 'page' : undefined}
      aria-label={t(studio.title)} aria-describedby={badgeId} onClick={() => { track('nav_studio', { navTarget: studio.id, studio: studio.id, inOverflow: inPanel }); choose(() => onChooseStudio(studio)); }}>
      {inPanel && <span className="om-studio-heading-icon" data-tone={studioIconTone(studio)}><RemixIcon name={studio.icon} size={17} /></span>}
      {t(studio.title)}{badge && <span className="om-badge" data-nav-badge={badge} id={badgeId} lang="en">{badge}</span>}
    </Button>;
  }

  const indices = Array.from({ length: count }, (_, index) => index);
  const hidden = indices.slice(visibleCount);
  return <nav ref={rail} className="om-creative-navigation" data-compact-actions={overflowActions ? true : undefined} aria-label={t('Creative studio')}>
    <div className="om-creative-strip" ref={strip}>
      {indices.map(index => <div key={index} data-nav-slot="" data-studio-start={index === studioStart || undefined}
        data-stowed={index >= visibleCount || undefined} inert={index >= visibleCount}>{item(index)}</div>)}
      <div ref={more} data-stowed={!hasMore || undefined} inert={!hasMore}>
        <Popover container={popupHost} modal={false} align="end" openOnHover open={moreOpen && hasMore}
          onOpenChange={next => { setOpen(null); setMoreOpen(next); }} aria-label={t('More Studio')} className="om-selection-panel om-nav-more-panel"
          trigger={<Button variant="plain" type="button" className="om-nav-item">{t('More Studio')}</Button>}>
          {moreOpen && (overflowActions || hidden.some(index => index < studioStart)) && <div className="om-nav-more-tools">
            {overflowActions?.(() => setMoreOpen(false))}
            {hidden.filter(index => index < studioStart).map(index => <div key={index}>{item(index, true)}</div>)}
          </div>}
          {moreOpen && <section aria-label={t('Studios')}>
            <div className="om-nav-more-studios">{hidden.filter(index => index >= studioStart).map(index => <div key={index}>{item(index, true)}</div>)}</div>
          </section>}
        </Popover>
      </div>
    </div>
  </nav>;
}
