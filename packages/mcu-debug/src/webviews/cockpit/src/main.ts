import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app')! });

if (import.meta.env.DEV) {
    import('./dev-mock').then(({ startMock }) => startMock());
}

export default app;
