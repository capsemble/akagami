# Chapter 3 — Newton's Laws of Motion

## 3.1 Force, and the only force that matters

A force is a push or a pull. It has a size, measured in newtons (N), and a direction. A 10 N push to the east is not the same force as a 10 N push to the west, and adding those two gives zero, not twenty.

A body in this chapter is usually pushed by several forces at once: a hand, gravity, the surface pushing back, friction. None of those forces, taken alone, decides what the body does. What decides is the **net force**, the single force left after every force on the body has been added as a vector. Draw them on one free-body diagram — the body by itself, every force that acts on it, and none of the forces it exerts on anything else — and add them. That sum is written ΣF. Newton's laws only ever talk about ΣF.

Two habits cause most of the wrong answers that follow. The first is to leave a force off the diagram because it feels passive. The floor "just sits there", so the normal force never gets drawn. The second is to put onto the diagram a force the body exerts on something else, and then let it cancel a force on the body. A diagram is a list of forces on one body. A force that body exerts belongs on somebody else's diagram.

## 3.2 The first law: velocity stays what it is

**If the net force on a body is zero, its velocity does not change.** Velocity means speed and direction together. Rest is the special case of a velocity that is already zero, so a body at rest stays at rest, and a body moving at 4 m/s due east keeps moving at 4 m/s due east, for as long as the net force remains zero.

This is the law of inertia. Mass, measured in kilograms, is the measure of that inertia: how unwilling the velocity is to be changed. Mass is not a force, and it is not the same quantity as weight.

The law is easy to say and hard to believe, because everyday motion is full of hidden forces. A football rolls to a stop. A cart halts when you stop pushing. It is natural to conclude that motion uses up a supply of force, and that a body needs a continuous push in order to keep a constant speed. The football did not run out of force. Friction and air resistance were forces on it the whole way, the net force was not zero, and the velocity changed because of that. Take the same ball onto smooth ice, where those forces are nearly nothing, and a gentle shove sends it across the rink at close to constant speed. The shove changed the velocity. After the shove, with the net force about zero, the new velocity simply persists.

A worked case shows the size of the effect. A 2 kg puck on ice is pushed up to 4 m/s and released. Treat friction as zero. Ten seconds later the puck is still at 4 m/s, and it is 40 m from where it was released. Nothing had to keep pushing it.

Now put a 2 kg block on a table where friction is a steady 0.4 N opposing the motion, and give it the same 4 m/s. The net force is −0.4 N, so the acceleration is −0.4 / 2 = −0.2 m/s². The block takes 20 s to stop, and it covers 40 m while it does. Stopping is a case of a non-zero net force, not a case of the first law. A student who says "it stops because you stopped pushing" is describing a world with a large hidden force, and has left that force off the diagram.

The test to apply is short. Constant velocity, including staying at rest, always means the net force is zero. A changing velocity always means the net force is not zero. There is no third option in which a body slows down by itself.

## 3.3 The second law: acceleration is net force divided by mass

When the net force is not zero, the velocity changes. The rate of that change is the acceleration, and the second law fixes its size and its direction:

    ΣF = m a

    a = ΣF / m

ΣF is in newtons, m is in kilograms, and a is in metres per second squared. The acceleration points the same way as the net force, not the same way as the velocity. A cart being braked has its velocity forward and its acceleration backward. A ball on the way up still has an upward velocity and a downward acceleration.

Over a short time dt the velocity and the position update from that acceleration. With u the velocity at the start of the step:

    v = u + a * dt
    x = x + v * dt

Two proportionalities follow at once, and both are easy to misread as statements about speed.

Double the net force and the acceleration doubles. The speed does not double at that instant. Speed is what the acceleration accumulates over time. Starting from rest, v = a t, and the distance covered is x = (1/2) a t². A small force applied for a long time can produce a larger speed than a large force applied for a moment.

Double the mass and the same net force produces half the acceleration. A heavier body is not harder to keep moving. It is harder to speed up or to slow down. Keeping a constant velocity still costs a net force of zero, whatever the mass is.

The confusion between force and speed is the mistake to kill. Push a trolley harder and it is tempting to say "more force means more speed". More force means more acceleration. How fast the trolley is going depends on how long that acceleration has been applied, and on how fast the trolley was already going. The second law does not contain a speed. It contains the rate at which velocity changes.

A newton is the force that gives a 1 kg mass an acceleration of 1 m/s², which means 1 N = 1 kg·m/s². An answer that comes out as an acceleration in kilometres, or a force in kilograms, has mixed the quantities, and the number cannot be used.

Worked example. A 4 kg cart on a level track starts from rest. A steady horizontal push of 10 N acts on it, and friction is negligible, so the net force is 10 N. Then a = 10 / 4 = 2.5 m/s², in the direction of the push. After 4 s the cart is moving at v = 2.5 × 4 = 10 m/s, and it has travelled x = (1/2) × 2.5 × 16 = 20 m. Change any one input and the 20 m moves. Raise the mass to 8 kg and the acceleration falls to 1.25 m/s², so in the same 4 s the cart covers only 10 m. Raise the push to 20 N on the original 4 kg cart and the acceleration rises to 5 m/s², so the cart covers 40 m. The destination is a consequence of a = ΣF / m applied for a known time. It is not a property of the push by itself.

## 3.4 Weight is a force; mass is not

Near the Earth, gravity pulls a body downward with a force called its weight:

    W = m g

with g = 9.81 m/s². Weight is in newtons. Mass is in kilograms. A 3 kg crate has a weight of 3 × 9.81 = 29.43 N. The crate's mass does not become 29.43 of anything.

On the Moon, g is about 1.62 m/s², so the same crate weighs 3 × 1.62 = 4.86 N and is much easier to lift. Its mass is still 3 kg. Shoved horizontally by the same net force, it has exactly the same acceleration it had on Earth, because a = ΣF / m and neither the force nor the mass changed. Inertia did not shrink when the local g shrank. Substituting the weight in place of the mass, in a horizontal problem, mixes the two quantities and the acceleration comes out in the wrong unit.

Weight is one force among others on the free-body diagram. A crate at rest on a table has its weight downward and a normal force from the table upward. The first law requires the net force to be zero, so the normal force equals the weight and points the other way. Those two forces are equal because the acceleration is zero. They are not a third-law pair. They are different kinds of force, and both of them act on the crate.

The same balance holds for vertical motion at constant speed. A 2 kg lantern hangs from a rope. Its weight is 2 × 9.81 = 19.62 N downward. If the tension in the rope is also 19.62 N upward, the net force is zero and the lantern's velocity is constant. That velocity may be zero, or it may be a steady crawl downward. A student who says "if it is moving down, the downward force must be winning" has confused velocity with acceleration. Constant downward speed means the forces balance.

If instead the tension is 12 N, the net force is 19.62 − 12 = 7.62 N downward, and a = 7.62 / 2 = 3.81 m/s² downward. The lantern speeds up as it descends. Cut the rope and the tension becomes zero. The net force is then the weight, 19.62 N, and a = g = 9.81 m/s².

Every body in free fall near the Earth has this same acceleration, heavy or light, because a = W / m = (m g) / m = g. The mass cancels. A feather falls more slowly in air because drag is another force on its diagram, and drag is large beside the feather's tiny weight. Remove the air and the feather and a hammer land together. Free fall does not mean "no forces". It means the only force left is the weight.

## 3.5 Friction belongs inside the net force

Friction is a force. It opposes sliding, or the tendency to slide, and it acts along the surface. Leaving it out of the net force is the same error as leaving out the normal force. The second law then runs on the wrong sum and returns a confident wrong acceleration.

For a body that is already sliding, kinetic friction has magnitude

    f_k = μ_k N

where μ_k is the coefficient of kinetic friction and N is the normal force. On a level surface with no other vertical force, N equals the weight, so

    f_k = μ_k m g

and the direction is opposite the velocity.

Static friction is a different rule, and using one formula for both is a standard mistake. While the body is still at rest, static friction takes whatever value is needed to keep the net force at zero, up to a maximum of μ_s N. It is not automatically equal to that maximum. A gentle 2 N push on a heavy crate does not produce an acceleration of 2 / m. It produces a static friction of 2 N the other way, a net force of zero, and no motion at all. Only a push past the maximum gets the crate moving. Once it is moving, friction typically drops to the kinetic value, which is smaller than the maximum static value.

Worked example, on a level floor. A 10 kg crate is already sliding. μ_k = 0.20 and g = 9.81, so

    f_k = 0.20 × 10 × 9.81 = 19.62 N

opposing the motion. A porter pushes in the direction of motion with 30 N. Both forces are horizontal, so

    ΣF = 30 − 19.62 = 10.38 N

    a = 10.38 / 10 = 1.038 m/s²

Treat the push as if it were the net force and the reported acceleration is 30 / 10 = 3 m/s², nearly three times too large. The whole content of the second law is the word "net". The push is an input. The acceleration answers to what remains after every other horizontal force has been included.

The same crate, same friction, pushed with exactly 19.62 N, has a net force of zero. By the first law it keeps whatever speed it already has. Pushed with only 10 N, which is less than the friction, the net force is 9.62 N backward and the crate slows down. A force applied forward can produce an acceleration backward. The push and the acceleration point the same way only when the push is the only horizontal force.

## 3.6 The third law: the twin force acts on the other body

**If body A exerts a force on body B, then body B exerts a force on body A.** The two forces are equal in size, opposite in direction, and of the same kind: both gravitational, or both contact. They act on different bodies, and they happen at the same time. There is no interval in which the action occurs and the reaction follows later.

The pair does not cancel. Cancellation is what happens to two forces on one free-body diagram. The two halves of a third-law pair are never on the same diagram, so they can never sum to zero on either body. Each body feels only its own half, and that half is an ordinary contribution to that body's net force.

Asked why an apple falls, many people say the Earth pulls harder on the apple than the apple pulls on the Earth. It does not. The gravitational pull on the apple and the gravitational pull on the Earth are a third-law pair, equal in size. The apple's acceleration is large because a = F / m and the apple's mass is small. The Earth's acceleration toward the apple is that same F divided by the mass of the Earth, which is far too small to notice. Equal forces, very unequal accelerations. The second law, applied once to each body, is the whole of the explanation.

The other common sentence is "the action and the reaction cancel, so nothing can ever accelerate." That sentence has put both halves of the pair onto one object. A mule pulls a cart forward, and the cart pulls the mule backward with a force of the same size. Those two forces do not both act on the cart. On the cart's own diagram the forward force is the pull from the mule, and the force that opposes it is friction at the wheels. If the mule's pull is the larger of those two, the cart's net force is forward and the cart speeds up. A force of equal size does exist, but it exists on the mule, which is a different diagram.

Worked example, one pair and two bodies. A 2 kg probe and a 6 kg supply crate float at rest, with no other horizontal force on either of them. A spring between them pushes for 1.0 s with a steady 12 N. On the probe the net force is 12 N, so a = 12 / 2 = 6 m/s², and after one second the probe is moving at 6 m/s. On the crate the net force is 12 N the other way, so a = 12 / 6 = 2 m/s², and the crate is moving at 2 m/s in the opposite direction.

The forces were equal. The accelerations are in the inverse ratio of the masses: 6 to 2 is 3 to 1, and 6 kg / 2 kg is 3. The momenta are equal and opposite, 2 × 6 = 6 × 2 = 12 kg·m/s. That equality is the third law read as momentum, and it is why the centre of mass of the two bodies stays put.

Change the masses and the split of the speeds changes. Replace the crate with a second 2 kg probe and the same 12 N push for 1.0 s sends each probe off at 6 m/s. Replace it with a 24 kg crate and the crate reaches only 12 / 24 = 0.5 m/s, while the probe still reaches 6 m/s. The lighter body always takes the larger share of the speed. Giving both bodies the same acceleration means the second law was applied once to the pair, instead of once to each body.

## 3.7 One cart, all three laws

The numbers below are small enough to check by hand, and each law is doing a different job.

The cart, load included, has mass 8 kg. It starts at rest on level ground. Kinetic friction at the wheels is a steady 4 N, opposing the motion. A porter pushes horizontally with a steady 20 N for 3.0 s and then lets go.

While the porter pushes, the horizontal forces on the cart are +20 N and −4 N.

    ΣF = 20 − 4 = 16 N
    a = 16 / 8 = 2 m/s²

From rest, after 3.0 s:

    v = 2 × 3 = 6 m/s
    x = (1/2) × 2 × 9 = 9 m

The velocity changed during those three seconds, so the first law was not the law in charge. It would take over when the porter lets go only if the friction vanished too. It does not. After the push, the only horizontal force on the cart is −4 N.

    a = −4 / 8 = −0.5 m/s²

The cart slows from 6 m/s and stops after 6 / 0.5 = 12 s. In that time it covers a further 6 × 12 + (1/2) × (−0.5) × 144 = 72 − 36 = 36 m. It comes to rest 45 m from where it started. Stopping the cart at the 9 m mark, at the instant the hands come off, assumes a net force of zero that this diagram does not contain.

The third law is on the porter, who is a different body. He pushes the cart with 20 N, so the cart pushes him backward with 20 N. Separately, his boots push the ground backward, and the ground pushes his boots forward. If that forward force from the ground is greater than the 20 N backward force from the cart, the porter's own net force is forward and he walks forward with the cart. If his boots cannot find that much friction, the cart's push on him wins and his feet slip backward. The 20 N on the cart and the 20 N on the porter are equal, opposite, and on different diagrams. Neither cancels the other.

Three questions sort every problem in this chapter. Which single body is the diagram for? What is the net force on that body, once weight and friction are both on the diagram? If that net force is zero, the velocity stays as it is. If it is not zero, the acceleration is the net force divided by the mass, and the twin of every force drawn here lives on the other body.
