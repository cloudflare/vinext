// @flow
// This page is written in flowtype to test Babel's functionality.
// Ported from the Next.js e2e fixture: test/e2e/babel/
import React from 'react'

type Props = {}

export default class MyComponent extends React.Component<Props> {
  render(): React.Node {
    return <div id="text">Test Babel</div>
  }
}
