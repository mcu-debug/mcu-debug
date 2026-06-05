import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'The MCU-Debug Core',
    Svg: require('@site/static/img/undraw_docusaurus_mountain.svg').default,
    description: (
      <>
        A modern, drop-in replacement for <code>cortex-debug</code>. Offers transparent remote probe support (WSL2/containers/SSH), dual-mode RTT polling, workspace-scoped UARTs, and a standalone CLI/TUI.
      </>
    ),
  },
  {
    title: 'Companion Extensions',
    Svg: require('@site/static/img/undraw_docusaurus_tree.svg').default,
    description: (
      <>
        Extend your environment with dedicated visualizers: SVD{' '}
        <a
          href="https://marketplace.visualstudio.com/items?itemName=mcu-debug.peripheral-viewer"
          target="_blank"
          rel="noopener noreferrer">
          Peripheral Viewer
        </a>
        , community-driven{' '}
        <a
          href="https://marketplace.visualstudio.com/items?itemName=mcu-debug.rtos-views"
          target="_blank"
          rel="noopener noreferrer">
          RTOS Views
        </a>{' '}
        (with contributions from ARM), and the high-performance{' '}
        <a
          href="https://marketplace.visualstudio.com/items?itemName=mcu-debug.memory-view"
          target="_blank"
          rel="noopener noreferrer">
          MemoryView
        </a>
        .
      </>
    ),
  },
  {
    title: 'DAP-Compatible & Modular',
    Svg: require('@site/static/img/undraw_docusaurus_react.svg').default,
    description: (
      <>
        Built using the standard Debug Adapter Protocol. The companion extensions are fully decoupled and can be used with MCU-Debug or <b>any</b> other DAP-compliant debug adapter.
      </>
    ),
  },
];

function Feature({title, Svg, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
