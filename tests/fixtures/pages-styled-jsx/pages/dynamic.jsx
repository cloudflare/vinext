// Ported from Next.js: test/e2e/styled-jsx-dynamic/pages/index.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/styled-jsx-dynamic/pages/index.js
import DynamicStyled from "../components/DynamicStyled";
import Header from "../components/Header";
import Footer from "../components/Footer";

export default function Page({ mainColor }) {
  return (
    <div>
      <style jsx>{`
        div {
          color: ${mainColor};
        }
      `}</style>
      <Header bg="navy" fg="white" />
      <main>
        <DynamicStyled color="blue" />
      </main>
      <Footer color="purple" />
    </div>
  );
}

export function getServerSideProps() {
  return {
    props: {
      mainColor: "green",
    },
  };
}
