import './globals.css'
import Header from 'components/header'
import SystemInfo from 'components/server-info'
import Footer from 'components/footer'

export const metadata = {
  title: 'Hacker News — vinext + Cloudflare Workers',
  description: 'Hacker News clone built with React Server Components, running on vinext + Cloudflare Workers.',
  robots: {
    index: true,
    follow: true
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
