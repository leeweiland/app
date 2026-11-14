import UIKit
import Capacitor
import WebKit

// Swipe in from the left edge = back (iPhone's equivalent of Android's back
// button). It walks the WebView's history, and chat-header.js's PRABack
// pushes a history entry whenever a thread/popup/lightbox opens -- so the
// swipe closes that instead of doing nothing. With no history it's a no-op.
class PRABridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.allowsBackForwardNavigationGestures = true
    }
}

// Same as Capacitor's generated SceneDelegate except the root view controller
// is the subclass above. Codemagic's `rm -rf ios && npx cap add ios`
// regenerates this file every build, so it's copied back in from ios-config/.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = PRABridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
