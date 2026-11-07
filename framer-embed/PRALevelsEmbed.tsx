// Framer code component for pacificrimathletics.com/levels.
// Embeds the public Levels board and grows to its full height (the board
// reports its height with postMessage), so the page has one scrollbar and
// the board keeps loading students as visitors scroll.
import { addPropertyControls, ControlType } from "framer"
import { useEffect, useState } from "react"

const BOARD_ORIGIN = "https://app-production-3c6a1.up.railway.app"

/**
 * @framerSupportedLayoutWidth any
 * @framerSupportedLayoutHeight auto
 */
export default function PRALevelsEmbed(props) {
    const [height, setHeight] = useState(1200)

    useEffect(() => {
        const onMessage = (e) => {
            if (e.origin !== BOARD_ORIGIN) return
            if (e.data && e.data.type === "pra-levels-height") setHeight(e.data.height)
        }
        window.addEventListener("message", onMessage)
        return () => window.removeEventListener("message", onMessage)
    }, [])

    return (
        <iframe
            src={props.url}
            scrolling="no"
            title="Pacific Rim Athletics Levels"
            style={{ width: "100%", height, border: 0, display: "block", background: "#000" }}
        />
    )
}

addPropertyControls(PRALevelsEmbed, {
    url: {
        type: ControlType.String,
        title: "URL",
        defaultValue: BOARD_ORIGIN + "/chat-app/levels-public.html",
    },
})
