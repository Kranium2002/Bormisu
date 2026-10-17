import { useState, type RefObject } from 'react';
import { errorText } from '../data/errors';
import { buildChartSvg, canCopyImage, chartFileName, copyPng, svgBlob, svgToPng, type ChartExportInfo } from '../export/chartImage';
import { downloadBlob } from '../export/download';
import { useT } from '../i18n';
import { useAppStore } from '../store/appStore';
import styles from './ChartExport.module.css';

interface Props {
  /** The chart's root <svg>. */
  target: RefObject<SVGSVGElement | null>;
  /** Caption, legend and file name of the image (in the language of the chart's screen). */
  info: ChartExportInfo;
}

/**
 * Small icon buttons next to a chart: copy it as a PNG (paste into Word, PowerPoint, Slack), download
 * the PNG, or download the SVG. The image is the chart alone with its caption and legend, in the
 * print look (see export/chartImage.ts), never what is selected on screen. Where the page can't put an
 * image on the clipboard (no ClipboardItem, insecure origin, permission refused) COPY downloads the
 * PNG instead and the toast says so. Hidden in print.
 */
export function ChartExport({ target, info }: Props) {
  const t = useT();
  const showToast = useAppStore((s) => s.showToast);
  const [busy, setBusy] = useState(false);

  const build = () => (target.current ? buildChartSvg(target.current, info) : null);
  const failed = (e: unknown) => showToast(`${t('Could not create the chart image')}: ${errorText(e)}`);
  const run = (work: Promise<unknown>) => {
    setBusy(true);
    void work.finally(() => setBusy(false));
  };

  const copy = () => {
    const chart = build();
    if (!chart) return;
    // Started right in the click, and handed to the clipboard as a promise (Safari).
    const png = svgToPng(chart);
    const instead = (why: string) =>
      png.then((blob) => {
        downloadBlob(blob, chartFileName(info.fileBase, 'png'));
        showToast(why);
      }, failed);
    run(
      canCopyImage()
        ? copyPng(png).then(
            () => showToast(t('Chart copied')),
            () => instead(t('Could not copy to the clipboard: the chart was downloaded instead')),
          )
        : instead(t('Copying images isn’t available here: the chart was downloaded instead')),
    );
  };

  const downloadPng = () => {
    const chart = build();
    if (!chart) return;
    run(
      svgToPng(chart).then((blob) => {
        downloadBlob(blob, chartFileName(info.fileBase, 'png'));
        showToast(t('Chart downloaded'));
      }, failed),
    );
  };

  const downloadSvg = () => {
    const chart = build();
    if (!chart) return;
    downloadBlob(svgBlob(chart), chartFileName(info.fileBase, 'svg'));
    showToast(t('Chart downloaded'));
  };

  return (
    <div className={styles.tools} role="group" aria-label={t('Chart image')} aria-busy={busy}>
      <button type="button" className={styles.tool} aria-label={t('Copy chart as image')} title={t('Copy chart as image')} disabled={busy} onClick={copy}>
        <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
          <rect x="7" y="7" width="9.5" height="10" rx="1" />
          <path d="M13 4.5V4a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H5" />
        </svg>
      </button>
      <button type="button" className={styles.tool} aria-label={t('Download chart as PNG')} title={t('Download chart as PNG')} disabled={busy} onClick={downloadPng}>
        <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.icon}>
          <path d="M10 3v9.5M6 8.5l4 4 4-4M4 16.5h12" />
        </svg>
      </button>
      <button type="button" className={styles.svgTool} aria-label={t('Download chart as SVG')} title={t('Download chart as SVG')} disabled={busy} onClick={downloadSvg}>
        SVG
      </button>
    </div>
  );
}
