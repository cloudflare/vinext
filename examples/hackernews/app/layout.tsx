import './globals.css'
import Header from 'components/header'
import SystemInfo from 'components/server-info'
import Footer from 'components/footer'

export const metadata = {
  title: 'Hacker News — vinext + Cloudflare Workers',
  description: 'Hacker News clone built with React Server Components, running on vinext + Cloudflare Workers.',
  // Demo deploy on a *.vinext.workers.dev host: keep it out of the index so it
  // does not compete with vinext.dev for the project's own brand term.
  robots: {
    index: false,
    follow: false
  }
}

export const viewport = {
  themeColor: '#ffa52a'
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <main>
          <Header />
          <div className="page">
            {children}
            <Footer />
            <SystemInfo />
          </div>
        </main>
      </body>
    </html>
  )
}
