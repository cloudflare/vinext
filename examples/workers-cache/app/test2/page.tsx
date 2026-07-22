'use client';

export const dynamic = 'force-dynamic';

import { useState } from "react";

export default function Page() {
	const [values, setValues] = useState<Record<string,Headers>>({});

	const doFetch = (accept = 'application/json') => {
		fetch('/api/test', { headers: { accept } }).then((v) => setValues((p) => ({...p, [accept]: v.headers})))
	}

	const onClick = async () => {
		doFetch('application/json');
		await new Promise((res) => setTimeout(res, 100));
		doFetch('text/plain');
	}

	return (<>
		<button onClick={onClick}>Fetch</button>
		{Object.entries(values).map(([key, val]) => (<div key={key}><span>{key}</span><code>{JSON.stringify(Object.fromEntries(val.entries()), null, 2)}</code></div>))}
	</>)
}
